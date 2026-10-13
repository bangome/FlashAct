# Cooperative Benchmark Stop

This change fixes the experimental visible-latency harness only. Production
`src/**`, package metadata, the v0.1 tarball, and previously accepted timing
reports remain unchanged. It does not establish native hidden-tab support or a
new latency SLA.

## Failure Reproduction

The former `Promise.race([run(), stop])` rejected the waiter without cancelling
or joining the producer. Controlled RED reproductions against the original
entrypoint recorded:

- Deferred launch: final write/summary preceded launch return and a late
  `newContext` call; the late browser was not closed by that cleanup pass.
- Deferred checkpoint: final write preceded checkpoint completion, permitting
  the checkpoint to overwrite the supposedly final report.
- Actual pending Chromium evaluation: stop attempted salvage before closure;
  the evaluation remained pending after stop until owned closure eventually ran.

The original source snapshot and event order are retained in unique
`artifacts/qa/benchmark-stop/red-*.json` receipts. The RED fixture is historical:
it refuses to run against the corrected entrypoint rather than presenting an
import error as a behavioral regression.

## Corrected Lifecycle

`visible-latency-benchmark.mjs` is an import-safe CLI wrapper.
`visible-latency-runner.mjs` owns the serial producer and final report.
`visible-latency-owned.mjs` owns stop state, acquisitions, native operations,
resource closure and draining. `visible-latency-report.mjs` owns exclusive output
reservation and report formatting. The page-local timing algorithm is unchanged.

1. SIGINT, SIGTERM, SIGHUP, watchdog and trial deadlines converge on the first
   stop reason through an AbortController; repeated requests are idempotent.
2. Checks before and after each stage prevent subsequent acquisitions, trials
   and successful sample acceptance after stop.
3. Acquisition promises remain observed. Ownership is registered before the
   post-await check; resources returned after stop are closed without advancing.
4. Owned context closure starts before awaiting a pending evaluation. Context
   closure owns its page/CDP disposal; browser termination is an escalation if
   context closure stalls. Native launch signal handlers are disabled so the
   runner is the signal owner. No undocumented launch AbortSignal is used.
5. The producer, acquisitions, closure operations and checkpoint writes settle
   before a final cloned report is written and one summary is emitted.
6. Interrupted rows retain only last host-observed evidence and are not
   completed successes. Cancellation is not an undo operation.

If a native operation cannot settle, the drain deadline emits
`SHUTDOWN_UNCONFIRMED` with pending operations. It does not manufacture clean
teardown or a joined final report. These operations remain owned and awaited;
finite termination of an unreachable third-party operation is not guaranteed.

## Output Protection And Commands

Default output is a new UUID-named file; the accepted `visible-latency.json`
dataset is not overwritten. Explicit output must have an existing parent
directory and must be a new file. Exclusive creation rejects existing files and
aliases; protected baseline/package paths are rejected before browser work.

```sh
# Normal one-trial lifecycle control; output gets a fresh name.
node scripts/visible-latency-benchmark.mjs --control

# Unchanged default 25-trial measurement matrix; fresh output.
node scripts/visible-latency-benchmark.mjs

# Explicit new report and watchdog, with its parent directory already present.
node scripts/visible-latency-benchmark.mjs \
  --output artifacts/qa/benchmark-stop/my-new-run.json --watchdog-ms 150000

# Unit and real Chromium stop regressions.
npm test -- tests/unit/visible-latency-stop.test.mjs \
  tests/e2e/visible-latency-stop.test.mjs
```

Watchdog and drain settings must be integer milliseconds in `[1, 150000]`.
Normal success exits 0. Interrupted/failed runs exit 1 with
`PARTIAL_OR_FAILED`, a stop reason and explicit cleanup state.

## Verification Scope

The parent directly drove the actual Node CLI through a real Chromium adapter
boundary for delayed launch plus SIGINT, a genuine unresolved page Promise plus
SIGINT, and the same pending evaluation plus watchdog. Stage handshakes—not
startup sleeps—determined when to send the signal. Each run exited normally
without signal termination, emitted one final summary, drained pending work,
closed owned resources and preserved protected hashes. Reports were read after
child close, when producer/stdout/IPC had exited and further writes were impossible.

Separate parent controls verified one actual local click and the complete
25-trial matrix with 25 successes and no duplicate clicks. These are lifecycle
controls, not replacements for the accepted latency audit.

Implementation receipts and parent `manual-*-manual-receipt.json` records are
under `artifacts/qa/benchmark-stop/`. Default regression tests passed **331**
cases; the existing six opt-in live Aside cases were skipped for this experimental
script-only change. Strict project typecheck and no-emit build checks passed.
MJS syntax checks and executed tests cover the new modules; unavailable LSP is
not represented as clean diagnostics.

The demonstrated fault cases use freshly launched local Chromium, not borrowed
user browsers or remote sessions. Abrupt SIGKILL, OS termination and unreachable
native operations are not certified cleanup paths. Prior platform, synthetic
click, clock-stability and hidden-visibility limitations remain in force.

Independent gate verdict: **APPROVE**, recorded in
`artifacts/qa/benchmark-stop/review-final.json`. The reviewer traced ownership,
native close-before-join, checkpoint/final-write order, late acquisitions and
unconfirmed diagnostics; it audited the parent control/fault receipts and ran
independent scope assertions. This resolves the named cooperative-stop race
within the documented local-run contract, not universally bounded termination.
