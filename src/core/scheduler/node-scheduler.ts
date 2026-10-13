export interface Clock {
  epochNow(): number;
  /** Process-local monotonic milliseconds; not comparable across processes. */
  monotonicNow(): number;
}

/** Independent host scheduler contract, also implementable by a native backend. */
export interface Scheduler {
  schedule(atEpochMs: number, callback: () => void): () => void;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const systemClock: Clock = {
  epochNow: () => Date.now(),
  monotonicNow: () => performance.now(),
};

export class NodeScheduler implements Scheduler {
  constructor(private readonly clock: Clock = systemClock) {}

  /** Asynchronous, single-shot; rechecks wall time after every timer wake. */
  schedule(atEpochMs: number, callback: () => void): () => void {
    if (!Number.isFinite(atEpochMs)) {
      throw new RangeError("Deadline must be finite epoch milliseconds");
    }

    let active = true;
    const delay = (): number =>
      Math.min(MAX_TIMER_DELAY_MS, Math.max(1, Math.ceil(atEpochMs - this.clock.epochNow())));
    const wake = (): void => {
      if (!active) return;
      if (this.clock.epochNow() < atEpochMs) {
        timer = setTimeout(wake, delay());
        return;
      }
      active = false;
      callback();
    };
    let timer = setTimeout(wake, delay());

    return (): void => {
      active = false;
      clearTimeout(timer);
    };
  }
}
