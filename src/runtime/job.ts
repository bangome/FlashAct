import type { ExecutionPlan, JobState, JobStatus, JobTiming } from "../core/types.js";
import type { RuntimeDom } from "./dom.js";
import type { createTriggers } from "./triggers.js";

export type JobServices = {
  readonly dom: RuntimeDom;
  readonly triggers: typeof createTriggers;
  readonly valid: () => boolean;
};

/** One mutable lifecycle closure per job; no host-side references survive serialization. */
export function createJob(plan: ExecutionPlan, services: JobServices) {
  const { dom } = services;
  let timing: JobTiming = {};
  let result: JobStatus = { jobId: plan.jobId, state: "VALIDATED", executions: 0, updatedAt: Date.now() };
  let cleanup = () => {};
  let wakeCheck = () => {};
  function wake(): JobStatus {
    if (result.state === "WAITING") wakeCheck();
    return result;
  }
  function active(): boolean { return result.state === "WAITING" || result.state === "ARMED"; }
  function update(state: JobState, message?: string): JobStatus {
    result = { jobId: plan.jobId, state, executions: result.executions, updatedAt: Date.now(), timing: { ...timing },
      ...(message === undefined ? {} : { message }) };
    document.dispatchEvent(new CustomEvent("__flashact_status__", { detail: { jobId: plan.jobId } }));
    return result;
  }
  function finish(state: JobState, message: string): JobStatus {
    cleanup();
    return update(state, message);
  }
  function invalidate(): void {
    if (active() || result.state === "VALIDATED" || result.state === "DISPATCHED") finish("INVALIDATED", "Document or approved URL changed");
  }
  function status(): JobStatus {
    if (!services.valid() || location.href !== plan.guards.approvedUrl) invalidate();
    return result;
  }
  function cancel(): JobStatus {
    if (active() || result.state === "VALIDATED") return finish("CANCELLED", "Cancelled before dispatch");
    return status();
  }
  function arm(): JobStatus {
    if (status().state !== "VALIDATED") return result;
    timing = { receivedEpochMs: dom.now() };
    if (Date.now() >= plan.expiresAt) return finish("EXPIRED", "Plan expired before arm");
    const conditions = services.triggers(plan.trigger, dom);
    const targetTimes = conditions.scheduled;
    if (targetTimes.length) timing = { ...timing, targetEpochMs: Math.max(...targetTimes) };
    const candidates = dom.select(plan.target.selector);
    let target = candidates[0];
    const canAppear = conditions.appearances.has(plan.target.selector);
    if (candidates.length > 1 || (!target && !canAppear)) return finish("FAILED", "Action target must be unique at arm");
    let approvedRoot: Element | undefined;
    if (plan.target.watchRoot) {
      const roots = dom.select(plan.target.watchRoot);
      approvedRoot = roots[0];
      if (roots.length !== 1 || !approvedRoot) return finish("FAILED", "Watch root must be unique at arm");
      if (target && !approvedRoot.contains(target)) return finish("FAILED", "Action target is outside watch root");
    }
    let timer = 0;
    let verifyTimer = 0;
    let verificationObserver: MutationObserver | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let clickListener: ((event: Event) => void) | undefined;
    let errorListener: ((event: ErrorEvent) => void) | undefined;
    function rejectRemoval(records: readonly MutationRecord[]): boolean {
      if (target && records.some((record) => Array.from(record.removedNodes).some((node) => node === target || node.contains(target ?? null)))) {
        finish("FAILED", "Cached action target was removed");
        return true;
      }
      return false;
    }
    const observer = new MutationObserver((records) => {
      if (!active()) return;
      timing = { ...timing, observerEpochMs: dom.now() };
      if (rejectRemoval(records)) return;
      check();
    });
    cleanup = () => {
      clearTimeout(timer);
      clearTimeout(verifyTimer);
      observer.disconnect();
      resizeObserver?.disconnect();
      verificationObserver?.disconnect();
      if (clickListener) window.removeEventListener("click", clickListener, true);
      if (errorListener) window.removeEventListener("error", errorListener);
    };
    function verify(): void {
      if (!services.valid() || location.href !== plan.guards.approvedUrl) { invalidate(); return; }
      const selector = plan.verification.selector;
      if (selector === undefined) {
        finish(timing.clickEpochMs === undefined ? "UNKNOWN" : "VERIFIED", "Synthetic local click only; no server-success guarantee");
        return;
      }
      const deadline = performance.now() + plan.verification.timeoutMs;
      const inspect = () => {
        if (!services.valid() || location.href !== plan.guards.approvedUrl) { invalidate(); return; }
        if (dom.select(selector).length > 0) { finish("VERIFIED", "Verification selector observed; no server-success guarantee"); return; }
        if (performance.now() >= deadline) { finish("UNKNOWN", "Verification selector not observed before timeout; dispatch will not repeat"); return; }
        clearTimeout(verifyTimer);
        verifyTimer = window.setTimeout(inspect, Math.min(25, deadline - performance.now()));
      };
      verificationObserver = new MutationObserver(inspect);
      verificationObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
      inspect();
    }
    function dispatch(element: HTMLElement): void {
      cleanup();
      // Claim the execution before invoking page code, including reentrant arm/status calls.
      result = { ...result, executions: 1 };
      update("DISPATCHED");
      let listenerFailed = false;
      clickListener = (event) => {
        if (event.target === element && timing.clickEpochMs === undefined) {
          timing = { ...timing, clickEpochMs: dom.now() };
          update("DISPATCHED");
        }
      };
      errorListener = () => { listenerFailed = true; };
      window.addEventListener("click", clickListener, true);
      window.addEventListener("error", errorListener);
      try {
        // HTMLElement.click emits an untrusted synthetic event, not a trusted physical gesture.
        HTMLElement.prototype.click.call(element);
      } catch (error) {
        finish("UNKNOWN", error instanceof Error ? error.message : "Click threw an unknown value; dispatch will not repeat");
        return;
      } finally {
        window.removeEventListener("click", clickListener, true);
        window.removeEventListener("error", errorListener);
      }
      if (result.state !== "DISPATCHED") return;
      if (listenerFailed) { finish("UNKNOWN", "Page click listener threw; dispatch will not repeat"); return; }
      verify();
    }
    function check(): void {
      if (!active()) return;
      clearTimeout(timer);
      if (!services.valid() || location.href !== plan.guards.approvedUrl) { invalidate(); return; }
      if (Date.now() >= plan.expiresAt) { finish("EXPIRED", "Trigger did not complete before expiry"); return; }
      if (approvedRoot && !approvedRoot.isConnected) { finish("FAILED", "Approved watch root was removed"); return; }
      if (!target) {
        const appeared = dom.select(plan.target.selector, approvedRoot ?? document);
        if (appeared.length > 1) { finish("FAILED", "Appearing action target is ambiguous"); return; }
        target = appeared[0];
        if (target) resizeObserver?.observe(target);
      }
      if (target && (!target.isConnected || !target.matches(plan.target.selector) || (approvedRoot && !approvedRoot.contains(target)))) {
        finish("FAILED", "Cached action target detached or selector changed"); return;
      }
      if (conditions.ready()) {
        timing = { ...timing, conditionEpochMs: dom.now() };
        // Only check uniqueness; never replace the cached target with another match.
        if (!(target instanceof HTMLElement) || dom.select(plan.target.selector).length !== 1 || !dom.enabled(target) || !dom.visible(target)) {
          finish("FAILED", "Cached action target is missing, ambiguous, disabled, or invisible"); return;
        }
        if (!plan.guards.allowIrreversible && dom.irreversible(target)) { finish("FAILED", "Irreversible action requires explicit approval"); return; }
        if (Date.now() >= plan.expiresAt) { finish("EXPIRED", "Plan expired before dispatch"); return; }
        if (!services.valid() || location.href !== plan.guards.approvedUrl) { invalidate(); return; }
        dispatch(target);
        return;
      }
      const future = targetTimes.filter((at) => at > Date.now());
      const delay = Math.max(1, Math.min(25, plan.expiresAt - Date.now(), ...future.map((at) => at - Date.now())));
      timer = window.setTimeout(() => { timing = { ...timing, schedulerEpochMs: dom.now() }; check(); }, delay);
    }
    const roots = approvedRoot ? new Set<Node>([approvedRoot]) : conditions.roots;
    roots.add(target?.parentElement ?? approvedRoot ?? document.body ?? document.documentElement);
    for (const root of roots) observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    resizeObserver = new ResizeObserver(() => { timing = { ...timing, observerEpochMs: dom.now() }; check(); });
    if (target) resizeObserver.observe(target);
    update("WAITING");
    wakeCheck = () => {
      if (!rejectRemoval(observer.takeRecords())) check();
    };
    check();
    return result;
  }
  return { arm, wake, cancel, status, invalidate };
}
