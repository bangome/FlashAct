import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeScheduler } from "../../src/core/scheduler/node-scheduler.js";
import type { Clock } from "../../src/core/scheduler/node-scheduler.js";

describe("NodeScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("rechecks the deadline when the epoch clock falls behind a timer wake", () => {
    // Given
    let epoch = 1_000;
    const clock: Clock = { epochNow: () => epoch, monotonicNow: () => performance.now() };
    const callback = vi.fn();
    const scheduler = new NodeScheduler(clock);
    scheduler.schedule(1_005, callback);
    // When
    vi.advanceTimersByTime(5);
    // Then
    expect(callback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    epoch = 1_005;
    vi.advanceTimersByTime(5);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("prevents dispatch when canceled repeatedly before the deadline", () => {
    // Given
    const callback = vi.fn();
    const cancel = new NodeScheduler().schedule(1_005, callback);
    // When
    cancel();
    cancel();
    vi.advanceTimersByTime(10);
    // Then
    expect(callback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the replacement timer when an early wake has rearmed it", () => {
    // Given
    const clock: Clock = { epochNow: () => 1_000, monotonicNow: () => performance.now() };
    const callback = vi.fn();
    const cancel = new NodeScheduler(clock).schedule(1_005, callback);
    vi.advanceTimersByTime(5);
    // When
    cancel();
    vi.advanceTimersByTime(10);
    // Then
    expect(callback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("chunks long deadlines without overflowing Node's timer delay", () => {
    // Given
    const cap = 2_147_483_647;
    const callback = vi.fn();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    new NodeScheduler().schedule(1_000 + cap + 10, callback);
    // When
    vi.advanceTimersByTime(cap);
    // Then
    expect(timeout.mock.calls.map((call) => call[1])).toEqual([cap, 10]);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    expect(callback).toHaveBeenCalledTimes(1);
    timeout.mockRestore();
  });

  it("dispatches asynchronously once when the deadline is already past", () => {
    // Given
    const callback = vi.fn();
    new NodeScheduler().schedule(999, callback);
    expect(callback).not.toHaveBeenCalled();
    // When
    vi.advanceTimersByTime(10);
    // Then
    expect(callback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([NaN, Infinity, -Infinity])("rejects nonfinite deadline %s", (deadline) => {
    // Given
    const scheduler = new NodeScheduler();
    // When / Then
    expect(() => scheduler.schedule(deadline, vi.fn())).toThrow(RangeError);
    expect(vi.getTimerCount()).toBe(0);
  });
});
