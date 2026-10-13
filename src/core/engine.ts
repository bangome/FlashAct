import type { AdapterOptions, AdapterStopReason, BrowserAdapter } from '../adapters/browser-adapter.js';
import { createAdapter, createOwnedAdapter } from '../adapters/factory.js';
import type { AdapterFactoryOptions } from '../adapters/factory.js';
import { jobStatusSchema, parsePlan, targetInfoSchema, browserTabsSchema } from './schema.js';
import type { Backend, BackendCapabilities, ExecutionInfo, ExecutionPlan, JobState, JobStatus, Trigger } from './types.js';
import { NodeScheduler } from './scheduler/node-scheduler.js';
import type { Scheduler } from './scheduler/node-scheduler.js';
import { assertNever, FlashActError } from '../utils/errors.js';

export type EngineOptions = {
  readonly adapters?: Partial<Readonly<Record<Backend, BrowserAdapter>>>;
  readonly adapterOptions?: AdapterOptions;
  readonly adapterOptionsByBackend?: Partial<Readonly<Record<Backend, AdapterFactoryOptions>>>;
  readonly now?: () => number;
  readonly adapterMode?: 'direct' | 'owned';
  readonly scheduling?: 'browser' | 'auto' | 'host';
  readonly scheduler?: Scheduler;
};
type Job = {
  readonly plan: ExecutionPlan;
  status: JobStatus;
  installed: boolean;
  armSent: boolean;
  stopRequested: boolean;
  execution?: ExecutionInfo;
  cancellation?: Promise<JobStatus>;
  statusRead?: Promise<JobStatus>;
  readonly schedules: Set<() => void>;
  readonly operations: Set<Promise<unknown>>;
};
type Connection = {
  readonly backend: Backend;
  readonly adapter: BrowserAdapter;
  ready: Promise<void>;
  unsubscribe?: () => void;
  stopping?: Promise<void>;
};

function scheduledLeaves(trigger: Trigger): readonly number[] {
  switch (trigger.type) {
    case 'SCHEDULED': return [trigger.at];
    case 'AND': case 'OR': return trigger.conditions.flatMap(scheduledLeaves);
    case 'ELEMENT_APPEAR': case 'ELEMENT_ENABLE': case 'ELEMENT_VISIBLE':
    case 'ATTRIBUTE_CHANGE': case 'TEXT_CHANGE': return [];
    default: return assertNever(trigger);
  }
}

function progress(state: JobState): number {
  switch (state) {
    case 'DRAFT': return 0;
    case 'VALIDATED': return 1;
    case 'ARMED': return 2;
    case 'WAITING': return 3;
    case 'DISPATCHED': return 4;
    case 'VERIFIED': case 'UNKNOWN': case 'FAILED': case 'EXPIRED':
    case 'CANCELLED': case 'INVALIDATED': return 5;
    default: return assertNever(state);
  }
}

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

/** Host wakes only request readiness; the injected runtime owns guards and dispatch. */
export class JobEngine {
  private readonly jobs = new Map<string, Job>();
  private readonly connections = new Map<Backend, Connection>();
  private readonly events: JobStatus[] = [];
  private readonly operations = new Set<Promise<unknown>>();
  private readonly cleanupErrors: unknown[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private readonly now: () => number;
  private readonly scheduler: Scheduler;

  constructor(private readonly options: EngineOptions = {}) {
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? new NodeScheduler();
  }

  get defaultScheduling(): ExecutionInfo['requested'] { return this.options.scheduling ?? 'browser'; }

  capabilities(): readonly BackendCapabilities[] {
    return (['playwright', 'aside'] as const).map<BackendCapabilities>(backend => {
      const injected = this.options.adapters?.[backend];
      const owner = injected?.owner;
      const owned = injected ? Boolean(owner) : this.options.adapterMode === 'owned';
      const options = this.options.adapterOptionsByBackend?.[backend] ?? this.options.adapterOptions ?? {};
      return { backend, connectionConfigured: Boolean(injected) || backend === 'aside' || Boolean(options.launch || options.endpoint),
        transport: owner ? owner.kind === 'aside-client' ? 'owned-aside-cli' : 'owned-worker'
          : owned ? backend === 'aside' ? 'owned-aside-cli' : 'owned-worker' : 'direct',
        hostWake: injected ? Boolean(owner && injected.wake) : owned && backend === 'playwright',
        shutdown: owned ? 'owned' : 'cooperative' };
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new FlashActError('INVALID_STATE', 'Engine is closing'));
    const result = this.queue.then(() => {
      if (this.closing) throw new FlashActError('INVALID_STATE', 'Engine is closing');
      return operation();
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private job(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new FlashActError('JOB_NOT_FOUND', 'Job does not exist');
    return job;
  }

  private update(job: Job, status: JobStatus): JobStatus {
    const previous = job.status;
    const executions = Math.max(previous.executions, status.executions);
    let state = status.state;
    const stale = status.executions < previous.executions || progress(status.state) < progress(previous.state);
    if (isTerminal(previous.state)) {
      state = executions > previous.executions ? 'UNKNOWN' : previous.state;
    } else if (stale) state = previous.state;
    const timing = previous.timing || status.timing
      ? stale ? { ...status.timing, ...previous.timing } : { ...previous.timing, ...status.timing }
      : undefined;
    const safe: JobStatus = { jobId: job.plan.jobId, state, executions,
      updatedAt: Math.max(previous.updatedAt, status.updatedAt),
      ...(timing ? { timing } : {}), ...(job.execution ? { execution: job.execution } : {}) };
    if (previous.state !== state || previous.executions !== executions) {
      // Deliberately omit free-form runtime messages: they may contain page data or URLs.
      this.events.push({ jobId: safe.jobId, state, executions, updatedAt: safe.updatedAt,
        ...(job.execution ? { execution: job.execution } : {}) });
      if (this.events.length > 1000) this.events.shift();
    }
    job.status = safe;
    if (isTerminal(state) || state === 'DISPATCHED') this.disarm(job);
    return safe;
  }

  private state(job: Job, state: JobState): JobStatus {
    return this.update(job, { jobId: job.plan.jobId, state, executions: job.status.executions, updatedAt: this.now() });
  }

  private async observe(job: Job, adapter: BrowserAdapter, reconciling = false): Promise<JobStatus | undefined> {
    try {
      const status = jobStatusSchema.parse(await this.sdk(job, () => adapter.getStatus(job.plan.jobId)));
      if (status.jobId !== job.plan.jobId) throw new FlashActError('INVALID_RESPONSE', 'Runtime returned a different job');
      if (status.executions < job.status.executions) return reconciling ? undefined : job.status;
      return this.update(job, status);
    } catch (error) {
      if (error instanceof Error) return undefined;
      throw error;
    }
  }

  private async cancelInstalled(job: Job, adapter: BrowserAdapter): Promise<JobStatus> {
    if (!adapter.owner) {
      const current = await this.observe(job, adapter, true);
      if (job.armSent && current && isTerminal(current.state)) return current;
    } else if (job.armSent && isTerminal(job.status.state) && job.status.state !== 'UNKNOWN' && job.status.state !== 'FAILED') {
      return job.status;
    }
    // A failed cancellation acknowledgement is not proof of cancellation or of no dispatch.
    await this.sdk(job, () => adapter.cancel(job.plan.jobId)).catch((error: unknown) => { if (!(error instanceof Error)) throw error; });
    if (adapter.owner && isTerminal(job.status.state) && job.status.state !== 'UNKNOWN' && job.status.state !== 'FAILED')
      return job.status;
    const result = await this.observe(job, adapter, true);
    return result && isTerminal(result.state) ? result : this.state(job, 'UNKNOWN');
  }

  private async adapter(backend: Backend): Promise<BrowserAdapter> {
    const connected = this.connections.get(backend);
    if (connected) {
      if (connected.stopping) throw new FlashActError('ADAPTER_ERROR', 'Connection owner has stopped');
      await connected.ready;
      if (this.closing || connected.stopping) throw new FlashActError('INVALID_STATE', 'Connection is stopping');
      return connected.adapter;
    }
    if (this.closing) throw new FlashActError('INVALID_STATE', 'Engine is closing');
    const factory = this.options.adapterMode === 'owned' ? createOwnedAdapter : createAdapter;
    const adapter = this.options.adapters?.[backend] ?? factory(backend,
      this.options.adapterOptionsByBackend?.[backend] ?? this.options.adapterOptions ?? {});
    if (this.options.adapterMode === 'owned' && !adapter.owner)
      throw new FlashActError('INVALID_PLAN', 'Owned mode requires an owned adapter');
    const connection: Connection = { backend, adapter, ready: Promise.resolve() };
    this.connections.set(backend, connection);
    if (adapter.owner) connection.unsubscribe = adapter.owner.subscribe(status => {
      const job = this.jobs.get(status.jobId);
      if (job && job.plan.backend === backend) this.update(job, jobStatusSchema.parse(status));
    });
    connection.ready = this.sdk(undefined, () => adapter.connect());
    try { await connection.ready; }
    catch (error) {
      if (adapter.owner) await this.stopConnection(connection, 'deadline');
      else { await adapter.disconnect(); this.connections.delete(backend); }
      throw error;
    }
    if (this.closing || connection.stopping) {
      if (adapter.owner) await this.stopConnection(connection, 'shutdown');
      throw new FlashActError('INVALID_STATE', 'Engine is closing');
    }
    return adapter;
  }

  private sdk<T>(job: Job | undefined, operation: () => Promise<T>): Promise<T> {
    const request = operation();
    this.operations.add(request);
    job?.operations.add(request);
    const finished = () => { this.operations.delete(request); job?.operations.delete(request); };
    void request.then(finished, finished);
    return request;
  }

  private disarm(job: Job): void {
    for (const cancel of job.schedules) cancel();
    job.schedules.clear();
  }

  private active(job: Job): void {
    if (this.closing || job.stopRequested) throw new FlashActError('INVALID_STATE', 'Job is stopping');
  }

  private execution(job: Job, adapter: BrowserAdapter): ExecutionInfo {
    const requested = this.defaultScheduling;
    const capable = Boolean(adapter.owner && adapter.wake);
    if (requested === 'host' && !capable)
      throw new FlashActError('INVALID_PLAN', 'Host scheduling requires an owned wake adapter');
    const scheduled = scheduledLeaves(job.plan.trigger).length > 0;
    return { requested,
      scheduler: requested !== 'browser' && capable && (scheduled || requested === 'host') ? 'host-assisted' : 'browser',
      transport: adapter.owner ? adapter.owner.kind === 'aside-client' ? 'owned-aside-cli' : 'owned-worker' : 'direct',
      browserOwnership: adapter.owner?.kind === 'launched-browser' ? 'owned' : 'borrowed',
      reason: requested === 'browser' ? 'explicit-browser' : requested === 'host' ? 'explicit-host'
        : !adapter.owner ? 'cooperative-transport' : !adapter.wake ? 'unsupported-host-wake'
          : scheduled ? 'scheduled-leaves' : 'no-scheduled-leaves' };
  }

  private schedule(job: Job, adapter: BrowserAdapter): void {
    if (job.execution?.scheduler !== 'host-assisted' || isTerminal(job.status.state) || job.status.state === 'DISPATCHED') return;
    const wake = adapter.wake;
    if (!wake) throw new FlashActError('INVALID_PLAN', 'Host scheduling requires wake');
    const now = this.now();
    const leaves = [...new Set(scheduledLeaves(job.plan.trigger))].filter(at => at < job.plan.expiresAt);
    const times = [...leaves.filter(at => at > now), ...(leaves.some(at => at <= now) ? [now] : []), job.plan.expiresAt];
    for (const at of times) {
      const cancel = this.scheduler.schedule(at, () => {
        job.schedules.delete(cancel);
        if (this.closing || job.stopRequested || isTerminal(job.status.state) || job.status.state === 'DISPATCHED') return;
        if (at === job.plan.expiresAt) this.disarm(job);
        const request = this.sdk(job, () => wake.call(adapter, job.plan.jobId));
        void request.then(status => {
          const parsed = jobStatusSchema.parse(status);
          if (parsed.jobId !== job.plan.jobId) throw new FlashActError('INVALID_RESPONSE', 'Wake returned a different job');
          this.update(job, parsed);
        }).catch((error: unknown) => {
          if (!(error instanceof Error)) throw error;
          const connection = this.connections.get(job.plan.backend);
          if (connection) void this.stopConnection(connection, 'deadline').catch(failure => this.cleanupErrors.push(failure));
          this.state(job, 'UNKNOWN');
        });
      });
      job.schedules.add(cancel);
    }
  }

  private stopConnection(connection: Connection, reason: AdapterStopReason): Promise<void> {
    if (connection.stopping) return connection.stopping;
    const owner = connection.adapter.owner;
    if (!owner) return Promise.reject(new FlashActError('INVALID_STATE', 'No owned producer boundary'));
    for (const job of this.jobs.values()) {
      if (job.plan.backend === connection.backend) { job.stopRequested = true; this.disarm(job); }
    }
    const stopped = owner.stop(reason);
    connection.stopping = stopped.then(statuses => {
      for (const status of statuses) {
        const job = this.jobs.get(status.jobId);
        if (job && job.plan.backend === connection.backend) this.update(job, jobStatusSchema.parse(status));
      }
      for (const job of this.jobs.values()) {
        if (job.plan.backend !== connection.backend) continue;
        job.stopRequested = true; this.disarm(job);
        if (!isTerminal(job.status.state))
          this.state(job, job.armSent ? 'UNKNOWN' : reason === 'cancel' ? 'CANCELLED' : 'FAILED');
      }
    });
    return connection.stopping;
  }

  async createJob(input: unknown): Promise<JobStatus> {
    return this.serial(async () => {
      const plan = parsePlan(input);
      if (this.jobs.has(plan.jobId)) throw new FlashActError('INVALID_STATE', 'Job ID already exists');
      const status: JobStatus = { jobId: plan.jobId, state: 'DRAFT', executions: 0, updatedAt: this.now() };
      this.jobs.set(plan.jobId, { plan, status, installed: false, armSent: false, stopRequested: false,
        schedules: new Set(), operations: new Set() });
      this.events.push(status);
      return status;
    });
  }

  private async check(job: Job): Promise<BrowserAdapter> {
    this.active(job);
    if (job.plan.expiresAt <= this.now()) {
      this.state(job, 'EXPIRED');
      throw new FlashActError('GUARD_REJECTED', 'Job has expired');
    }
    const adapter = await this.adapter(job.plan.backend);
    this.active(job);
    await this.sdk(job, () => adapter.selectTab(job.plan.target.tabId));
    this.active(job);
    const target = targetInfoSchema.parse(await this.sdk(job, () => adapter.inspectTarget(job.plan.target.selector)));
    this.active(job);
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
      const connection = this.connections.get(job.plan.backend);
      if (!connection) throw new FlashActError('ADAPTER_ERROR', 'Missing connection');
      job.execution = this.execution(job, connection.adapter);
      return this.state(job, 'VALIDATED');
    });
  }

  async armJob(id: string): Promise<JobStatus> {
    return this.serial(async () => {
      const job = this.job(id);
      if (job.status.state !== 'VALIDATED') throw new FlashActError('INVALID_STATE', 'Validate before arming');
      const adapter = await this.check(job); // Recheck the live document immediately before installing.
      try {
        await this.sdk(job, () => adapter.installRuntime(job.plan));
        job.installed = true;
        this.active(job);
        job.armSent = true;
        await this.sdk(job, () => adapter.arm(job.plan));
        this.active(job);
        const status = this.state(job, 'ARMED');
        this.schedule(job, adapter);
        return status;
      } catch (error) {
        if (job.installed && !job.stopRequested) await this.cancelInstalled(job, adapter);
        else if (!job.armSent) this.state(job, job.stopRequested ? 'CANCELLED' : 'FAILED');
        else if (!isTerminal(job.status.state)) this.state(job, 'UNKNOWN');
        throw error;
      }
    });
  }

  async getStatus(id: string): Promise<JobStatus> {
    const job = this.job(id);
    if (this.closing) { await this.closing; return job.status; }
    if (job.statusRead) return job.statusRead;
    const request = (async () => {
      if (!job.installed || isTerminal(job.status.state)) return job.status;
      const adapter = this.connections.get(job.plan.backend)?.adapter;
      if (!adapter) return this.state(job, 'UNKNOWN');
      return await this.observe(job, adapter) ?? await this.cancelInstalled(job, adapter);
    })();
    job.statusRead = request;
    const finished = () => { delete job.statusRead; };
    void request.then(finished, finished);
    return request;
  }

  async cancelJob(id: string): Promise<JobStatus> {
    const job = this.job(id);
    if (this.closing) throw new FlashActError('INVALID_STATE', 'Engine is closing');
    if (job.cancellation) return job.cancellation;
    job.stopRequested = true; this.disarm(job);
    const connection = this.connections.get(job.plan.backend);
    const timer = connection?.adapter.owner ? setTimeout(() => {
      void this.stopConnection(connection, 'cancel').catch(error => this.cleanupErrors.push(error));
    }, 2000) : undefined;
    job.cancellation = (async () => {
      try {
        if (!job.installed) await Promise.allSettled([...job.operations]);
        if (job.installed && !job.armSent && connection) await this.cancelInstalled(job, connection.adapter);
        else if (!isTerminal(job.status.state)) {
          if (job.installed && connection) await this.cancelInstalled(job, connection.adapter);
          else this.state(job, 'CANCELLED');
        }
        await Promise.allSettled([...job.operations]);
        if (connection?.stopping) await connection.stopping;
        return job.status;
      } finally { if (timer) clearTimeout(timer); }
    })();
    return job.cancellation;
  }

  private async closeConnection(connection: Connection): Promise<void> {
    const timer = connection.adapter.owner ? setTimeout(() => {
      void this.stopConnection(connection, 'shutdown').catch(error => this.cleanupErrors.push(error));
    }, 2000) : undefined;
    try {
      await Promise.all([...this.jobs.values()].filter(job => job.plan.backend === connection.backend && job.installed)
        .map(job => this.cancelInstalled(job, connection.adapter)));
      await connection.adapter.disconnect();
    } catch (error) {
      if (connection.adapter.owner) {
        await this.stopConnection(connection, 'shutdown');
      } else throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (connection.stopping) await connection.stopping;
    }
  }

  private async finishClose(): Promise<void> {
    const connections = [...this.connections.values()];
    const ownedClosures = connections.filter(connection => connection.adapter.owner).map(connection => this.closeConnection(connection));
    const ownedResults = Promise.allSettled(ownedClosures);
    await this.queue;
    const directResults = await Promise.allSettled(connections.filter(connection => !connection.adapter.owner)
      .map(connection => this.closeConnection(connection)));
    for (const result of [...await ownedResults, ...directResults])
      if (result.status === 'rejected') this.cleanupErrors.push(result.reason);
    await Promise.allSettled([...this.operations]);
    for (const connection of connections) {
      connection.unsubscribe?.();
    }
    this.connections.clear();
    if (this.cleanupErrors.length) throw new AggregateError(this.cleanupErrors, 'Engine cleanup failed');
  }

  getResult(id: string): Promise<JobStatus> { return this.getStatus(id); }
  jobIds(): readonly string[] { return [...this.jobs.keys()]; }
  logs(): readonly JobStatus[] { return [...this.events]; }

  listTabs(backend: Backend) {
    return this.serial(async () => {
      const adapter = await this.adapter(backend);
      if (this.closing) throw new FlashActError('INVALID_STATE', 'Engine is closing');
      return browserTabsSchema.parse(await this.sdk(undefined, () => adapter.listTabs()));
    });
  }

  inspectTarget(backend: Backend, tabId: string, selector: string) {
    return this.serial(async () => {
      const adapter = await this.adapter(backend);
      await this.sdk(undefined, () => adapter.selectTab(tabId));
      if (this.closing) throw new FlashActError('INVALID_STATE', 'Engine is closing');
      return targetInfoSchema.parse(await this.sdk(undefined, () => adapter.inspectTarget(selector)));
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    let resolveClose: () => void = () => undefined;
    let rejectClose: (error: unknown) => void = () => undefined;
    this.closing = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    for (const job of this.jobs.values()) {
      job.stopRequested = true; this.disarm(job);
    }
    void this.finishClose().then(resolveClose, rejectClose);
    return this.closing;
  }
}
