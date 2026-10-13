# Immediate native-hidden latency

Measured on 2026-10-13, 02:33:21.970-02:34:26.568 UTC, using Node v22.22.2,
Chrome for Testing/156.0.8078.4 and the actual compiled FlashAct runtime:
`769c2a5ffccd595d014de36c74c9a132019696f04cb311dd37c59e64ff16a391`.
Production source, package/tarball and earlier datasets were not changed.

## Results

Each cell contains 20 serialized jobs in the same genuinely minimized owned
window. All 40 produced one untrusted local fixture click and runtime VERIFIED,
with no duplicates, missing deliveries, early wall-clock guard violations or
negative deltas. This is click-delivery success, **not a latency SLA**.

| Scenario | Samples | Mean ms | Median ms | Min ms | Max ms | Over 50 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Scheduled, 12 ms ahead | 20 | 965.010 | 975.950 | 763.700 | 979.300 | 20 |
| Reactive, element enabled | 20 | 0.720 | 0.700 | 0.400 | 1.100 | 0 |

**All 20 scheduled samples miss a 50-ms lateness target.** Reactive response is
measured from the actual enabling setter, not the intended stimulus time. Its
page-local 1-second enabling timer itself was late by mean **986.675 ms**,
min 979.500 and max 990.600 ms. The small reactive response therefore does not
establish timely enabling, scheduled execution or an overall sub-50-ms outcome.

No population P99, SLA, reliability rate, timer-aging, sleep/wake or system-wide
saturation claim follows from these small cells. This run did not profile the
native scheduler or attribute the approximately one-second delays to a specific
browser/runtime layer. It did not compare concurrent or randomized visible and
hidden conditions.

Summary:
`artifacts/benchmark/hidden-latency-490929e8-cf34-4ee2-bec6-834a9b14f5ea.json`.
Protocol/lifecycle/raw measurement:
`artifacts/benchmark/controlled-hidden-probe-490929e8-cf34-4ee2-bec6-834a9b14f5ea.json`.

## Fresh gate and measurement ownership

`scripts/hidden-latency-benchmark.mjs` uses the existing Chrome/SDK worker owner.
The coordinator now has one optional awaited consumer, invoked only after its
fresh visible-hidden-visible gate passes. The default probe still runs only the
gate. Measurement setup does not bypass a failed gate.

After that complete gate, the consumer installs the actual compiled runtime
while visible, subscribes before the next trusted hidden event, then minimizes
the same owned target again. Native minimized bounds, raw CDP/Playwright agreement
and a trusted hidden entry are required before any job starts. All trial requests
use public CDP Runtime.evaluate with awaitPromise=true and userGesture=false.

The measured interval is about 60.449 seconds. Every row retains before/after
hidden snapshots and the trusted visibility audit accumulated since measurement
entry. Whole-interval audit, native bounds before/after, a final 40-event fixture
ledger and restoration are retained. The raw report records two minimize attempts:
one for the complete preliminary gate, one for measurement.

Only a fresh task-owned child, UUID profile, localhost fixture, target/window and
SDK worker are used. No user window/profile, getter override, headless visibility
substitute, stealth or native GUI input is involved.

## Timing and data validity

- Scheduled T0 is projected from adjacent high-resolution/page Date anchors.
  Uncertainty is 1 ms of wall quantization plus half the anchor span. Event wall
  time is separately checked against the integer target. Expiry is target wall
  time plus 3 seconds, not ARM time plus 3 seconds.
- E0 is captured immediately after the real native disabled setter. The intended
  enabling timer deadline and its actual lateness are separate fields.
- E1 is the actual runtime observer timestamp only when it is at/after E0;
  it is not independent mutation-only attribution.
- E2 is the authored document's independent fixture click-ledger timestamp.
  Scheduled lateness is E2 minus projected T0; reactive latency is E2 minus E0.
- Click/visibility listeners are installed before ARM, including synchronous
  dispatch. Collection awaits that event, a visibility loss or an explicit
  deadline; no status polling or guessed delay is added to hidden scheduling.
- Runtime cancel is acknowledged for every returned trial, with its actual
  receipt retained. Acknowledgment after VERIFIED does not undo the click.
- Invalid visibility, missing/non-finite timing, missing reactive E0, duplicates
  and inconsistent receipts cannot promote the final result. Missing latency is
  excluded, never converted to a successful zero. Raw samples remain retained.

`HIDDEN_MEASURED` means the planned dataset and delivery/visibility evidence are
complete. It does not mean that the latencies meet a target. The combined mean
in the JSON mixes two different trigger semantics; use the separate cells above.

## Stop and preservation evidence

Native controls held actual SDK replies rather than fabricating rejection:

| Control | Held reply | Attempted / completed | Retained outcome |
| --- | --- | ---: | --- |
| Gate SIGINT | First Browser.setWindowBounds, ID 55 | 0 / 0 | failed gate; no measurement |
| In-flight SIGINT | First hidden-trial Runtime.evaluate, ID 74 | 1 / 0 | UNKNOWN, no retry |
| In-flight watchdog | First hidden-trial Runtime.evaluate, ID 74 | 1 / 0 | UNKNOWN, no retry |

Zero completed replies is not a zero-execution claim: the browser may have
clicked before its held reply was lost. No post-stop page salvage or re-ARM
occurs. SDK worker termination is joined, followed by exact Chrome child close,
fixture closure and profile removal. All three controls finalized BLOCKED_OR_PARTIAL
with empty pending lists, completed cleanup and preserved inputs.

Aggregate control receipt:
`artifacts/qa/hidden-latency-stop-08de29ff-f4b3-4344-940f-fe93f5b8ea29.json`.
The normal measured child PID 13203 and its UUID profile were also absent after
cleanup. Control receipts identify exact PIDs/profiles and their checked absence.

The coordinator writes its exclusive raw report only after producer/cleanup
joins. The separate summary is created afterward, so it is not mislabeled as an
immutable input in the coordinator's preservation snapshot. Abrupt host failure,
SIGKILL during final commit and permanently stalled non-SDK filesystem calls are
not covered by these local receipts.

## Checks and reproduction

The deterministic regressions first exposed nine eligibility/timing failures;
the same file passed after the fixes. Final syntax and typecheck plus hidden,
visible-statistics and owned-shutdown regressions passed **75 tests**.
The new event fixture is measurement-only unit coverage, not proof of native
visibility or compiled-runtime integration. The actual 40-trial run supplies
that integration evidence.

The full suite was not repeated. Its previously disclosed two parallel-sensitive
integration failures remain unresolved. LSP is unavailable by prior decision;
there is no LSP-clean claim, installation, package publication or repack.

```sh
node scripts/hidden-latency-benchmark.mjs
node scripts/hidden-latency-stop-qa.mjs
npm run typecheck
node node_modules/vitest/vitest.mjs run \
  tests/unit/hidden-latency.test.mjs \
  tests/unit/visible-latency.test.mjs \
  tests/unit/controlled-hidden-probe-stop.test.mjs \
  tests/unit/controlled-probe-driver.test.mjs \
  tests/unit/controlled-probe-sdk.test.mjs
```

Every CLI run owns new resources and exclusive UUID outputs. A failed native
gate returns BLOCKED_OR_PARTIAL with zero attempts. An interrupted attempt remains
UNKNOWN with no retry. The CLI exits nonzero unless the measured dataset is valid.

Independent code/evidence gate: `.omo/evidence/hidden-latency-gate-review.md`,
recommendation APPROVE with no blockers. It reconciled all 40 protocol replies,
row formulas, fixture identities, native coverage, current input hashes and owned
resource absence without rerunning measurements. This is approval of the bounded
runner/evidence, not its scheduled latency, an SLA, or a clean full-suite claim.
