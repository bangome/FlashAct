// Only resources acquired by this fresh-launch run may enter this scope.
export class OwnedRun {
  controller = new AbortController();
  pending = new Map();
  resources = new Map();
  timers = new Set();
  events = [];
  errors = [];
  closing = false;

  constructor({ drainMs = 8000, diagnostic = value => console.error(JSON.stringify(value)) } = {}) {
    this.drainMs = drainMs;
    this.diagnostic = diagnostic;
  }

  check() { this.controller.signal.throwIfAborted(); }

  timer(action, milliseconds) {
    const timer = setTimeout(() => { this.timers.delete(timer); action(); }, milliseconds);
    this.timers.add(timer);
    return timer;
  }

  clear(timer) { clearTimeout(timer); this.timers.delete(timer); }

  track(name, operation) {
    const promise = Promise.resolve(operation);
    this.pending.set(promise, name);
    // Both handlers consume rejection; the original promise still rejects to its caller.
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }

  async stage(name, operation, milliseconds) {
    this.check();
    this.events.push({ event: 'start', name });
    const timer = milliseconds === undefined ? undefined : this.timer(() => this.stop(`deadline:${name}`), milliseconds);
    try {
      const result = await this.track(name, operation());
      this.check();
      return result;
    } finally {
      this.clear(timer);
      this.events.push({ event: 'settled', name });
    }
  }

  async acquire(name, operation, dispose) {
    return this.stage(`acquire:${name}`, async () => {
      const value = await operation();
      // Register BEFORE the stage's post-await abort check, including late acquisitions.
      this.resources.set(name, { value, dispose, state: 'open', closure: null });
      this.events.push({ event: 'owned', name });
      if (this.closing) this.closeOwned();
      return value;
    });
  }

  stop(reason) {
    if (this.controller.signal.aborted) return;
    this.controller.abort(new Error(reason));
    this.events.push({ event: 'stop', reason });
    this.beginClose();
  }

  close(name) {
    const entry = this.resources.get(name);
    if (!entry) return Promise.resolve();
    if (entry.closure) return entry.closure;
    entry.state = 'closing';
    this.events.push({ event: 'close-start', name });
    entry.closure = this.track(`close:${name}`, Promise.resolve().then(() => entry.dispose(entry.value)).then(() => {
      entry.state = 'closed';
      this.events.push({ event: 'closed', name });
    }, error => {
      entry.state = 'unconfirmed';
      this.errors.push({ phase: `cleanup-${name}`, message: error instanceof Error ? error.message : String(error) });
    }));
    return entry.closure;
  }

  closeOwned() {
    const context = this.resources.get('context');
    if (context) {
      // Context closure owns its pages and attached sessions. Concurrent explicit detach
      // races that native closure ("No session with given id"), so inherit its receipt.
      const closure = this.close('context');
      for (const name of ['page', 'cdp']) {
        const entry = this.resources.get(name);
        if (!entry || entry.closure) continue;
        entry.state = 'closing';
        entry.closure = this.track(`close:${name}`, closure.then(() => {
          entry.state = context.state;
          this.events.push({ event: entry.state, name, via: 'context' });
        }));
      }
    } else for (const name of ['cdp', 'page']) void this.close(name);
    void this.close('fixture');
    if (context?.state === 'closing') {
      // Browser termination is an escalation if native context closure stalls.
      if (!this.browserEscalation) this.browserEscalation = this.timer(() => { void this.close('browser'); }, Math.min(1000, this.drainMs));
      void context.closure.then(() => { this.clear(this.browserEscalation); void this.close('browser'); });
    } else void this.close('browser');
  }

  beginClose() {
    if (!this.closing) {
      this.closing = true;
      this.timer(() => {
        if (this.pending.size) {
          this.unconfirmed = true;
          this.diagnostic({ status: 'SHUTDOWN_UNCONFIRMED', cleanupSuccess: false,
            pending: [...this.pending.values()], reason: this.controller.signal.reason?.message ?? 'normal-drain',
            limitation: 'Native operations remain owned and awaited; no termination or final-report claim.' });
        }
      }, this.drainMs);
    }
    this.closeOwned();
  }

  async drain() {
    this.beginClose();
    while (this.pending.size) await Promise.allSettled([...this.pending.keys()]);
    this.closeOwned();
    while (this.pending.size) await Promise.allSettled([...this.pending.keys()]);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.events.push({ event: 'drained' });
  }

  snapshot() {
    return { teardown: Object.fromEntries(['fixture', 'browser', 'context', 'page', 'cdp'].map(name =>
      [name, this.resources.get(name)?.state ?? 'not-created'])),
    cleanupSuccess: !this.unconfirmed && this.pending.size === 0 && this.errors.length === 0
      && [...this.resources.values()].every(entry => entry.state === 'closed'),
    pending: [...this.pending.values()], stopReason: this.controller.signal.reason?.message ?? null,
    events: [...this.events], errors: [...this.errors] };
  }
}
