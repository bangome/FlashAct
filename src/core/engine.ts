import type { AdapterOptions, BrowserAdapter } from '../adapters/browser-adapter.js';
import { createAdapter } from '../adapters/factory.js';
import type { AdapterFactoryOptions } from '../adapters/factory.js';
import { jobStatusSchema, parsePlan, targetInfoSchema, browserTabsSchema } from './schema.js';
import type { Backend, ExecutionPlan, JobState, JobStatus, Trigger } from './types.js';
import { assertNever, FlashActError } from '../utils/errors.js';

export type EngineOptions = {
  readonly adapters?: Partial<Readonly<Record<Backend, BrowserAdapter>>>;
  readonly adapterOptions?: AdapterOptions;
  readonly adapterOptionsByBackend?: Partial<Readonly<Record<Backend, AdapterFactoryOptions>>>;
  readonly now?: () => number;
};
type Job = { readonly plan: ExecutionPlan; status: JobStatus; installed: boolean };

export function isTerminal(state: JobState): boolean {
  switch (state) {
    case 'VERIFIED': case 'UNKNOWN': case 'FAILED': case 'EXPIRED':
    case 'CANCELLED': case 'INVALIDATED': return true;
    case 'DRAFT': case 'VALIDATED': case 'ARMED': case 'WAITING': case 'DISPATCHED': return false;
    default: return assertNever(state);
  }
}

function permitsMissing(trigger: Trigger, selector: string): boolean {
  switch (trigger.type) {
    case 'ELEMENT_APPEAR': return trigger.selector === selector;
    case 'AND': return trigger.conditions.some(condition => permitsMissing(condition, selector));
    case 'OR': return trigger.conditions.every(condition => permitsMissing(condition, selector));
    case 'SCHEDULED': case 'ELEMENT_ENABLE': case 'ELEMENT_VISIBLE':
    case 'ATTRIBUTE_CHANGE': case 'TEXT_CHANGE': return false;
    default: return assertNever(trigger);
  }
}

/** Host control only: triggers and dispatch are owned exclusively by the injected runtime. */
export class JobEngine {
  private readonly jobs = new Map<string, Job>();
  private readonly connections = new Map<Backend, BrowserAdapter>();
  private readonly events: JobStatus[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private readonly now: () => number;

  constructor(private readonly options: EngineOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new FlashActError('INVALID_STATE', 'Engine is closing'));
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private job(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new FlashActError('JOB_NOT_FOUND', 'Job does not exist');
    return job;
  }

  private update(job: Job, status: JobStatus): JobStatus {
    const safe: JobStatus = { jobId: status.jobId, state: status.state, executions: status.executions,
      updatedAt: status.updatedAt, ...(status.timing ? { timing: status.timing } : {}) };
    if (job.status.state !== status.state) {
      // Deliberately omit free-form runtime messages: they may contain page data or URLs.
      this.events.push({ jobId: status.jobId, state: status.state, executions: status.executions, updatedAt: status.updatedAt });
      if (this.events.length > 1000) this.events.shift();
    }
    job.status = safe;
    return safe;
  }

  private state(job: Job, state: JobState): JobStatus {
    return this.update(job, { jobId: job.plan.jobId, state, executions: job.status.executions, updatedAt: this.now() });
  }

  private async observe(job: Job, adapter: BrowserAdapter): Promise<JobStatus | undefined> {
    try {
      const status = jobStatusSchema.parse(await adapter.getStatus(job.plan.jobId));
      if (status.jobId !== job.plan.jobId) throw new FlashActError('INVALID_RESPONSE', 'Runtime returned a different job');
      if (status.executions < job.status.executions) throw new FlashActError('INVALID_RESPONSE', 'Runtime lost an observed execution');
      return this.update(job, status);
    } catch (error) {
      if (error instanceof Error) return undefined;
      throw error;
    }
  }

  private async cancelInstalled(job: Job, adapter: BrowserAdapter): Promise<JobStatus> {
    const current = await this.observe(job, adapter);
    if (current && isTerminal(current.state)) return current;
    // A failed cancellation acknowledgement is not proof of cancellation or of no dispatch.
    await adapter.cancel(job.plan.jobId).catch((error: unknown) => { if (!(error instanceof Error)) throw error; });
    const result = await this.observe(job, adapter);
    return result && isTerminal(result.state) ? result : this.state(job, 'UNKNOWN');
  }

  private async adapter(backend: Backend): Promise<BrowserAdapter> {
    const connected = this.connections.get(backend);
    if (connected) return connected;
    const adapter = this.options.adapters?.[backend] ?? createAdapter(backend,
      this.options.adapterOptionsByBackend?.[backend] ?? this.options.adapterOptions ?? {});
    try { await adapter.connect(); }
    catch (error) {
      await adapter.disconnect();
      throw error;
    }
    this.connections.set(backend, adapter);
    return adapter;
  }

  async createJob(input: unknown): Promise<JobStatus> {
    return this.serial(async () => {
      const plan = parsePlan(input);
      if (this.jobs.has(plan.jobId)) throw new FlashActError('INVALID_STATE', 'Job ID already exists');
      const status: JobStatus = { jobId: plan.jobId, state: 'DRAFT', executions: 0, updatedAt: this.now() };
      this.jobs.set(plan.jobId, { plan, status, installed: false });
      this.events.push(status);
      return status;
    });
  }

  private async check(job: Job): Promise<BrowserAdapter> {
    if (job.plan.expiresAt <= this.now()) {
      this.state(job, 'EXPIRED');
      throw new FlashActError('GUARD_REJECTED', 'Job has expired');
    }
    const adapter = await this.adapter(job.plan.backend);
    await adapter.selectTab(job.plan.target.tabId);
    const target = targetInfoSchema.parse(await adapter.inspectTarget(job.plan.target.selector));
    if (target.url !== job.plan.target.url || target.url !== job.plan.guards.approvedUrl ||
        target.count > 1 || (target.count === 0 && !permitsMissing(job.plan.trigger, job.plan.target.selector)) ||
        (target.irreversible && !job.plan.guards.allowIrreversible)) {
      throw new FlashActError('GUARD_REJECTED', 'URL, unique target, or irreversible-action guard rejected');
    }
    return adapter;
  }

  async validateJob(id: string): Promise<JobStatus> {
    return this.serial(async () => {
      const job = this.job(id);
      if (job.status.state !== 'DRAFT' && job.status.state !== 'VALIDATED')
        throw new FlashActError('INVALID_STATE', 'Only draft jobs can be validated');
      await this.check(job);
      return this.state(job, 'VALIDATED');
    });
  }

  async armJob(id: string): Promise<JobStatus> {
    return this.serial(async () => {
      const job = this.job(id);
      if (job.status.state !== 'VALIDATED') throw new FlashActError('INVALID_STATE', 'Validate before arming');
      const adapter = await this.check(job); // Recheck the live document immediately before installing.
      try {
        await adapter.installRuntime(job.plan);
        job.installed = true;
        await adapter.arm(job.plan);
        return this.state(job, 'ARMED');
      } catch (error) {
        if (job.installed) await this.cancelInstalled(job, adapter);
        else this.state(job, 'FAILED');
        throw error;
      }
    });
  }

  async getStatus(id: string): Promise<JobStatus> {
    return this.serial(async () => {
      const job = this.job(id);
      if (!job.installed || isTerminal(job.status.state)) return job.status;
      const adapter = await this.adapter(job.plan.backend);
      return await this.observe(job, adapter) ?? await this.cancelInstalled(job, adapter);
    });
  }

  async cancelJob(id: string): Promise<JobStatus> {
    return this.serial(async () => {
      const job = this.job(id);
      if (isTerminal(job.status.state)) return job.status;
      if (job.installed) {
        const adapter = await this.adapter(job.plan.backend);
        return this.cancelInstalled(job, adapter);
      }
      return this.state(job, 'CANCELLED');
    });
  }

  getResult(id: string): Promise<JobStatus> { return this.getStatus(id); }
  jobIds(): readonly string[] { return [...this.jobs.keys()]; }
  logs(): readonly JobStatus[] { return [...this.events]; }

  listTabs(backend: Backend) {
    return this.serial(async () => browserTabsSchema.parse(await (await this.adapter(backend)).listTabs()));
  }

  inspectTarget(backend: Backend, tabId: string, selector: string) {
    return this.serial(async () => {
      const adapter = await this.adapter(backend);
      await adapter.selectTab(tabId);
      return targetInfoSchema.parse(await adapter.inspectTarget(selector));
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.queue.then(async () => {
      const errors: unknown[] = [];
      for (const job of this.jobs.values()) {
        if (!job.installed || (isTerminal(job.status.state) && job.status.state !== 'FAILED' && job.status.state !== 'UNKNOWN')) continue;
        try {
          const adapter = this.connections.get(job.plan.backend);
          if (adapter) await this.cancelInstalled(job, adapter);
          else this.state(job, 'UNKNOWN');
        } catch (error) { this.state(job, 'UNKNOWN'); errors.push(error); }
      }
      const results = await Promise.allSettled([...this.connections.values()].map(adapter => adapter.disconnect()));
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
      this.connections.clear();
      if (errors.length) throw new AggregateError(errors, 'Engine cleanup failed');
    });
    return this.closing;
  }
}
