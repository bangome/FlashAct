# Native-hidden scheduled execution: opt-in host wake

The updated local SDK exposes `PlaywrightAdapter.wake(jobId)` and root-exported
`wakeExpression(jobId)`. Wake reuses an armed job's existing guarded check, not a
raw click. Browser timers and reactive observers stay active; default
JobEngine/CLI/MCP scheduling is unchanged. Host scheduling adds transport and
caller ownership; it is not a pure browser-only dispatch path.

**Final-tree result:** browser timer mean869.780ms versus host-assisted guarded
wake mean14.055ms (median914.050ms versus3.900ms). The host-assisted20-row group
still had two above50ms, maximum90.700ms. This is a measured improvement, not an
all-row50ms guarantee.

## Diagnosis and prototype

The previous native-hidden20 scheduled rows in
`artifacts/benchmark/hidden-latency-490929e8-cf34-4ee2-bec6-834a9b14f5ea.json`
showed mean scheduler-callback lateness963.935ms and callback-to-fixture-click
1.075ms, accounting for mean965.010ms lateness. Reactive polling timestamps
preceding readiness are not their dispatch cause.

The unchanged-runtime prototype used the same owned minimized page, fresh
trusted visible-hidden-visible gate, balanced interleaved20/20 trials and12ms
deadline lead. Browser timer mean891.080ms, fixture-only host-CDP mean1.305ms;
zero early/duplicate clicks, preserved files and completed owned cleanup.
This baseline justified trying wake; it is NOT runtime guard/verification proof.
Evidence:
`artifacts/benchmark/hidden-scheduling-comparison-a7dcb37b-ae44-4bd2-b60f-923446ce31d7.json`.

## Guarded SDK comparison

Run the actual updated local build:

```sh
npm run typecheck
npm run build
node scripts/hidden-scheduling-comparison.mjs --guarded-wake
```

Both cells use the same compiled runtime, RuntimeJobs and public Playwright
`page.evaluate` transport. This includes the atomic token/runtime/document
binding and normal command overhead; only the host-assisted cell adds an
explicit NodeScheduler wake. The caller owns an SDK worker, stock installed
Chrome child/profile, CDP channels, fixture and exclusive reports.

Each row has1000ms deadline lead so SDK installation and ARM can finish first.
It is not a paired comparison with the12ms prototype. The two paths are
interleaved in alternating order with20 rows each on one genuinely minimized,
continuously audited hidden page. Completion subscribes to the independent
fixture click before ARM; no timing sleeps/polling or retries.

First guarded dataset:
`artifacts/benchmark/hidden-scheduling-comparison-9cafd75c-58ff-4209-b4a7-2b20a4073471.json`
(raw source uses the same ID under `controlled-hidden-probe-*.json`).

| Path | Mean lateness | Median | Maximum | Above50ms |
| --- | ---: | ---: | ---: | ---: |
| Browser timer |903.640ms|919.400ms|987.700ms|20/20|
| Host-assisted guarded wake |2.575ms|2.550ms|4.000ms|0/20|

All40 rows were actual local `VERIFIED` synthetic clicks, one execution and one
independent receipt each, with zero duplicates, early wall guards or negative
latencies beyond clock uncertainty. All were hidden, and owned cleanup and181
protected hashes completed unchanged during the run. The serialized runtime
SHA256 was `7215688bc26d9d0c894529b3c1a27971501300bb8f249470faf87c89edc59263`,
also confirmed from a fresh Node import of the current build.

Nineteen host rows captured explicit wake entry before click. One browser timer
won before the wake body entered; its wake-entry-at-click field is intentionally
null, and the later acknowledged wake did not duplicate execution. Old
`schedulerEpochMs` is not the host wake-entry clock.

## Contract and validation

- Wake is an explicit awaited capability, not automatic adapter scheduling.
  Unarmed/early/dispatched/terminal calls cannot force another execution.
- The original cached-target/URL/expiry/visibility/enabled/irreversible guards,
  browser wall+monotonic clocks and AND/OR semantics remain authoritative.
  Pending removal records are consumed before synchronous readiness checks,
  including same-task detach/reattach.
- All adapter control commands bind and invoke in one browser task. Captured
  reporters remain tied to their installed runtime; stale replies cannot erase
  cancellation, dispatch, terminal results or loss-induced UNKNOWN.
- Stop cancels future host timers. Already-started requests settle only through
  the actual producer/driver boundary, not an abandoned racing waiter. A borrowed
  production page does not acquire cancellable evaluation or bounded shutdown.

Project typecheck and build passed. The main related suite passed188 tests
across12 files; the extended owned-driver/host-timer suite passed8 (four new).
The final observation-binding regression passed31 adapter tests across2 files;
the new test prevents attributing replacement-runtime reports to an installed
job. Together these runs cover193 distinct related tests. The refreshed
typecheck and build also passed. No LSP installation was needed.

## Final-tree repeat and variability

After binding the console reporter to its captured runtime, the actual final
tree was rebuilt and measured again:
`artifacts/benchmark/hidden-scheduling-comparison-ffe55913-4d7d-4c5b-bfa3-6f75261b70e8.json`,
with raw `controlled-hidden-probe-ffe55913-*.json`.

| Path | Mean lateness | Median | Maximum | Above50ms |
| --- | ---: | ---: | ---: | ---: |
| Browser timer |869.780ms|914.050ms|1110.200ms|20/20|
| Host-assisted guarded wake |14.055ms|3.900ms|90.700ms|2/20|

All40 unique rows and independent receipts were local synthetic `VERIFIED`,
with no early/duplicate/clock-uncertainty violations. The second genuine hidden
interval had a trusted entry and no intervening visible events; native bounds
agreed before and after. Nineteen rows captured explicit wake entry; one timer
won before that body. SDK worker, Chrome, channels, page and fixture joined;
the profile was removed and183 protected source/old evidence/package hashes
were unchanged during the final run. Serialized runtime SHA256 stayed identical.

The90.700ms host-group row entered wake88.100ms after its projected deadline and
clicked2.600ms after entry; its host timer started8 integer wall milliseconds
late. The55.600ms row also had8ms host-timer lateness, but its browser timer won
before the wake body, so that entry interval is unavailable. Null is not zero.
The remaining wait/transport/processing contribution is not causally profiled.
Do not discard these outliers or replace the final result with the cleaner first
run.

This is a small local descriptive sample, not P99, SLA, remote-clock, sustained
hidden aging/CPU overload or site-acceptance proof. The two previously identified
unrelated full-parallel-suite failures remain outside this work; that full suite,
live Aside, CLI/MCP default acceleration and package reinstall are not claimed.
Old reports, tarball and package/config files are preserved; no publish,
repack or git commit.

Independent final gate returned APPROVE with no blockers:
`.omo/evidence/hidden-scheduling-improvement-review.md`. It recomputed native
rows/protocol/timing, matched182 protected files plus the runtime hash (183
entries), audited ownership/guards and independently passed typecheck. Test
execution totals remain the recorded parent runs, not an independent rerun.
The completion audit is in
`.omo/evidence/hidden-scheduling-improvement-checks.md`.
