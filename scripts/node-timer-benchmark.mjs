import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release } from "node:os";
import { performance } from "node:perf_hooks";

const count = 1_000;
const spacingMs = 5;
const observedToleranceMs = 50;
const output = new URL("../artifacts/benchmark/node-timer.json", import.meta.url);

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.ceil(p * sorted.length) - 1];
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: percentile(0.50),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted[sorted.length - 1],
  };
}

async function measure(name, blockMs) {
  const samples = [];
  const startedAt = new Date().toISOString();
  const startedMonotonicMs = performance.now();
  for (let trial = 0; trial < count; trial += 1) {
    const sample = await new Promise((resolve) => {
      const scheduledEpochMs = Date.now();
      const scheduledMonotonicMs = performance.now();
      const t0EpochMs = scheduledEpochMs + spacingMs;
      const t0MonotonicMs = scheduledMonotonicMs + spacingMs;
      setTimeout(() => {
        const t1MonotonicMs = performance.now();
        const t1EpochMs = Date.now();
        const monotonicDifferenceMs = t1MonotonicMs - t0MonotonicMs;
        resolve({
          trial,
          scheduledEpochMs,
          scheduledMonotonicMs,
          t0EpochMs,
          t1EpochMs,
          t0MonotonicMs,
          t1MonotonicMs,
          epochDifferenceMs: t1EpochMs - t0EpochMs,
          monotonicDifferenceMs,
          elapsedMonotonicMs: t1MonotonicMs - scheduledMonotonicMs,
          success: monotonicDifferenceMs >= 0 && monotonicDifferenceMs <= observedToleranceMs,
        });
      }, spacingMs);
      if (blockMs > 0) {
        const blockUntil = performance.now() + blockMs;
        while (performance.now() < blockUntil) {
          // Deliberate event-loop blocking workload, never used in the scheduler.
          Math.sqrt(performance.now());
        }
      }
    });
    samples.push(sample);
  }
  const success = samples.filter((sample) => sample.success).length;
  return {
    name,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: performance.now() - startedMonotonicMs,
    load: { kind: blockMs > 0 ? "blocking-event-loop" : "none", blockMsPerTrial: blockMs },
    stats: {
      ...summarize(samples.map((sample) => sample.monotonicDifferenceMs)),
      count: samples.length,
      success,
      failure: samples.length - success,
      early: samples.filter((sample) => sample.monotonicDifferenceMs < 0).length,
      overTolerance: samples.filter((sample) => sample.monotonicDifferenceMs > observedToleranceMs).length,
    },
    epochStats: {
      ...summarize(samples.map((sample) => sample.epochDifferenceMs)),
      early: samples.filter((sample) => sample.epochDifferenceMs < 0).length,
    },
    samples,
  };
}

const runs = [await measure("idle", 0), await measure("cpu-load", 8)];
const report = {
  timestamp: new Date().toISOString(),
  machine: {
    node: process.version,
    os: platform(),
    osRelease: release(),
    arch: arch(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    logicalCpuCount: cpus().length,
  },
  measurement: {
    implementation: "raw Node setTimeout, not NodeScheduler",
    trialsPerRun: count,
    totalCount: runs.reduce((sum, run) => sum + run.stats.count, 0),
    serial: true,
    spacingMs,
    units: "milliseconds",
    percentileMethod: "nearest-rank",
    observedToleranceMs,
    successDefinition: "callback monotonic T1-T0 is in [0, 50] ms; failure is early or over tolerance, not a pre-measurement assertion",
    clockNote: "Epoch uses Date.now (integer ms); monotonic uses performance.now. T0 is sampled scheduling time + 5 ms. Epoch/monotonic offset is sampled within this process only; it is not cross-process synchronization. Clock adjustments can change epoch differences independently.",
    loadNote: "CPU-load run deliberately blocks the measuring event loop for 8 ms immediately after each 5 ms timer is scheduled. This is a contention experiment, not a nonblocking scheduler or whole-machine saturation test.",
    cleanup: "No workers, intervals, or persistent timers; every single-shot timer completed before writing the report.",
  },
  runs,
};
await mkdir(new URL(".", output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ artifact: output.pathname, machine: report.machine, runs: runs.map(({ name, stats, epochStats }) => ({ name, stats, epochStats })) }, null, 2));
