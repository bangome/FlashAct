# Controlled probe shutdown

The shutdown repair was verified on 2026-10-13 with Node v22.22.2 and the
installed Playwright 1.64.0. This is lifecycle evidence, not hidden latency or
a performance certification. Production source, package metadata, tarball and
earlier measurement reports were preserved.

## Failure and reproduction

The historical report
`artifacts/benchmark/controlled-hidden-probe-006d87cd-7d5b-461b-81ff-45c803c3a08e.json`
remains a cleanup-pending checkpoint. Chrome root exit and close both completed
with code 0, and the client disconnected. The pending work was page CDP detach,
browser CDP detach and the page closure waiting for those detaches. The first
pending drain consequently prevented fixture closure and final report writing.

The former unit test made disconnect reject its fake detach promise. That
assumption was not the actual SDK contract.

`tests/fixtures/controlled-probe-sdk-repro.mjs` now uses the installed public
`chromium.connectOverCDP(ConnectOverCDPTransport)` API in an owned worker:

- With child `Runtime.runIfWaitingForDebugger` response ID 6 withheld, public
  detach stayed pending after transport close, the public disconnected event,
  rejection of a new public RPC, and a subsequent parent-to-worker checkpoint.
- With ID 6 acknowledged, root `Target.detachFromTarget` ID 7 was observed;
  closing the transport caused the SDK itself to reject detach.
- Worker termination was awaited in both branches. No synthetic child disposal,
  automatic detach rejection, sleep or abandoned racing waiter was used.

This reproduces the SDK mechanism without Chrome. The historical checkpoint
does not identify its exact internal request ID; that remains unconfirmed.

The normal-order regression failed before the repair with:
`Disconnect must not orphan a pending child detach: expected true to be false`.
The same test passes after the repair.

## Ownership and cancellation

`scripts/controlled-hidden-probe.mjs` retains ownership of the exact Chrome
child, UUID profile, fixture and exclusive report. Only Playwright objects and
their native WebSocket live in `controlled-probe-worker.mjs`.

Normal cleanup finishes CDP session detach and page closure, then disconnects.
The driver is terminated and joined before Chrome termination, fixture closure,
profile deletion and the final report commit. The attached default context is
never closed.

On SIGINT, SIGTERM, a stage deadline or the watchdog, the coordinator terminates
the SDK worker and signals only its owned Chrome child. Parent RPCs reject only
after the worker's exit event: the SDK producer has then actually stopped.
Pending acquisition cannot publish an SDK object after that boundary.

Interrupted SDK handles are recorded as `cancelled-with-driver`, not as
successfully detached. This state counts toward cleanup only after joined driver
exit and exact child close. Profile removal follows child close. SDK artifacts
also use that parent-owned profile rather than an untracked temporary directory.

The public transport records sent and received protocol IDs and session IDs,
including internal SDK operations. SDK objects, response handles and init-script
disposables never cross the structured-clone boundary.

## Native receipts

The normal native run is
`artifacts/benchmark/controlled-hidden-probe-8af5af48-129b-4f3d-bd91-21f2912a24c4.json`.
It has no errors or stop reason, no pending work, all teardown receipts complete,
`cleanupSuccess=true`, and matching before/after protected hashes. Chrome root
exit/close both report code 0. Driver exit code 1 is the receipt from explicitly
terminating the owned worker, not a successful natural worker exit.

Native hiding still failed: one minimize attempt, `hiddenObserved=false`,
no accepted visible-hidden-visible sequence, and successful bounds restoration.
The final status is correctly `BLOCKED`, with zero hidden or latency trials.

`scripts/controlled-probe-stop-qa.mjs` serially ran three new owned native
controls. Its fixture withholds an actual Chrome response before it reaches the
real SDK:

| Control | Held response | Stop reason | Finalization |
| --- | --- | --- | --- |
| Pending evaluate + SIGINT | Runtime.evaluate, ID 50 | SIGINT | complete |
| Pending attach + SIGINT | Browser.getVersion, ID 1 | SIGINT | complete |
| Pending evaluate + watchdog | Runtime.evaluate, ID 50 | watchdog | complete |

All three finalized `BLOCKED` with zero hidden trials, `cleanupSuccess=true`,
empty pending lists, joined driver exit, child exit/close code 0, fixture closure
where acquired, deleted profiles, absent exact child PIDs and preserved hashes.
The 6-second watchdog is itself the behavior under test; SIGINT is triggered by
the withheld-response event, not a fixed delay.

Aggregate receipt:
`artifacts/qa/controlled-probe-stop-27767352-5b52-4ffc-bf1c-c22868efec91.json`.
Individual reports are named in that receipt.

Two unsuccessful new attempts are also preserved:

- `controlled-hidden-probe-de7b2050-13ef-4dcb-b022-04399fd0366d.json`: final
  `BLOCKED` with successful cleanup after a non-cloneable init-script disposable
  exposed the worker return-value boundary. The worker now returns completion.
- `controlled-hidden-probe-1e872be9-41e4-4178-98c4-98a356adb1d2.json`: unchanged
  `INCOMPLETE` checkpoint after the QA fixture incorrectly matched an event with
  no request ID. Exact PID 48266 was subsequently absent; its exact UUID profile
  was removed and absence verified. Historical graceful join is unconfirmed.
  The fixture now requires a defined matching response ID.

## Checks and reproduction

```sh
npm run typecheck
node node_modules/vitest/vitest.mjs run \
  tests/unit/controlled-hidden-probe-stop.test.mjs \
  tests/unit/controlled-probe-driver.test.mjs \
  tests/unit/controlled-probe-sdk.test.mjs

# Creates a fresh owned headful Chrome, UUID profile and exclusive report.
node scripts/controlled-hidden-probe.mjs

# Separate serial shutdown controls; does not measure hidden latency.
node scripts/controlled-probe-stop-qa.mjs
```

Scoped regressions passed 12 tests; typecheck and script syntax checks passed.
The full default run was not green: 341 passed, six existing opt-in Aside cases
skipped, and two untouched integration cases failed. One tried to pause an
already advancing mock clock at epoch 0; the other required a scheduler timestamp
after setup/ARM crossed a real 180-ms deadline. The two files passed all 18 tests
when checked without file parallelism. Their sensitivity remains unresolved;
no test, assertion or production code was changed to hide those failures.

The TypeScript language server remains unavailable; no LSP-clean claim or
installation is made. Abrupt host/OS failure, SIGKILL during final commit and
arbitrarily stalled non-SDK filesystem operations are not covered by these local
shutdown receipts.

Independent gate review approved the shutdown repair and truthful reporting:
`.omo/evidence/controlled-probe-stop-gate-review.md`. It independently checked
current resource absence and preservation hashes against the recorded native
receipts. This approval does not certify native hiding, latency, or a green full
parallel suite.
