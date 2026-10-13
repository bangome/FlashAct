# FlashAct real-browser benchmark results

Measured on **2026-10-12**, in `/Users/bogyung/FlashAct`, against the repository's actual serialized browser runtime. These are local observations, not latency targets, guarantees, reservation success, or a trusted-input benchmark.

Follow-up at **08:04–08:06 UTC** corrected installed fixture resolution, added authored demo activation, and reran the two host baselines with explicit browser-dispatch receipt T2. The original 1,000-sample Playwright/Aside normal results below are preserved; they were not rerun or rewritten.

## Environment and raw evidence

- macOS/Darwin 25.4.0, arm64; Node v22.22.2.
- Playwright-owned Chromium **156.0.8078.4**, headless.
- Actual Aside browser, driven by the official CLI **1.26.1010.1739**. `aside guide` and `aside guide repl` were read after updating the CLI. No private Aside CDP endpoint or Playwright substitute was used.
- Aside's report `environment.headless` reflects the parsed option default, **not its actual browser configuration**: the Aside run used the existing visible browser and does not launch or configure it.
- Every benchmark page was an owned loopback fixture with `#reserve`, `type="button"`, initially disabled, with no form or service API. The fixture server uses an ephemeral port on `127.0.0.1`.

Raw reports preserve every normal and stress sample, click-event timestamps, runtime terminal status/timing where applicable, environment, clock calibration, and teardown receipts:

- [`playwright-browser.json`](../artifacts/benchmark/playwright-browser.json)
- [`playwright-node.json`](../artifacts/benchmark/playwright-node.json)
- [`playwright-cdp.json`](../artifacts/benchmark/playwright-cdp.json)
- [`aside-browser.json`](../artifacts/benchmark/aside-browser.json)
- [`fixture-installed.json`](../artifacts/benchmark/fixture-installed.json): installed-package HTTP and actual CLI demo receipts from an unrelated cwd.
- [`playwright-hidden.json`](../artifacts/benchmark/playwright-hidden.json): independently owned headed/hidden-tab attempt; `status:not-verified`, zero completed batches, native visibility remained `visible`. Its timeout and closed-resource receipts are preserved unchanged.

PNG confirmation is alongside each report. The Aside final snapshot and screenshot show **2,120 actual click events**: 2,000 normal clicks plus 120 successful smaller-scenario clicks. The 20 replacement trials correctly produced no clicks. Each browser report contains 2,140 trials in total, excluding the separate lifecycle probe.

## Normal results

All values below are milliseconds. Each row has **1,000 independent sequential trials**, 1,000 measured clicks, **zero failed deliveries, zero duplicate events, and 100% local click-delivery success**. Success means exactly one fixture click and, for runtime trials, terminal `VERIFIED`; it does **not** enforce a latency SLA. Percentiles use nearest rank. Failed trials are not converted into zero-latency observations.

| Backend/path | Trigger | Mean | p50 | p95 | p99 | Max | Raw negative deltas |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Playwright / browser runtime | Scheduled | 0.753 | 0.700 | 1.700 | 2.000 | 3.100 | 87 |
| Playwright / browser runtime | Element enabled | 0.108 | 0.100 | 0.200 | 0.300 | 0.600 | 0 |
| Aside / browser runtime | Scheduled | 1.064 | 1.100 | 2.100 | 2.400 | 35.700 | 31 |
| Aside / browser runtime | Element enabled | 0.230 | 0.200 | 0.400 | 0.500 | 1.200 | 0 |
| Playwright-owned / NodeScheduler + page.evaluate (T2 instrumented) | Scheduled | 1.806 | 2.005 | 2.599 | 2.769 | 3.882 | 1 |
| Playwright-owned / NodeScheduler + CDP Runtime.evaluate (T2 instrumented) | Scheduled | 1.838 | 2.052 | 2.596 | 2.735 | 3.067 | 2 |

**Do not hide the negative deltas:** scheduled deadlines use integer `Date.now()` guards, while event timing uses high-resolution clocks. Browser deadlines are projected from adjacent wall-clock/page-clock anchors; that projection has a 1 ms quantization uncertainty. There were **zero browser wall-clock guard violations** and **zero negative deltas beyond the stated uncertainty**. These observations do not establish sub-millisecond no-early guarantees.

Node/CDP page-versus-host calibration uses 15 round-trip samples and the minimum-RTT midpoint. The chosen offset and half-RTT uncertainty were:

| Path | Page minus host offset | Half RTT | Total uncertainty including Date quantization | Host Date guard violations | Early beyond uncertainty |
| --- | ---: | ---: | ---: | ---: | ---: |
| Node evaluate | 0.036 ms | 0.212 ms | 1.212 ms | 0 | 0 |
| CDP evaluate | 0.001 ms | 0.132 ms | 1.132 ms | 0 | 0 |

The comparison runs were sequential on separately owned browsers, not randomized, simultaneous, or statistically controlled across identical machine load. Small differences within clock uncertainty must not be presented as superiority. The Aside scheduled maximum is an observed outlier, not suppressed from the report.

## What is measured

### Browser-runtime trials

`src/benchmark/page-batch.ts` is serialized and evaluated inside the actual fixture document. Each trial installs and arms a new real `ExecutionPlan` through `globalThis.__flashactRuntime`, awaits a terminal runtime status, records the document's independent click ledger, and cancels the job in `finally`. A further observer turn is allowed before collection to expose duplicate dispatch. There is no CLI/process round trip in the measured per-event path.

- **T0:** scheduled trigger's integer epoch deadline, retained in runtime timing and `wallTargetEpochMs`. `sample.targetEpochMs` is the adjacent page-clock projection used for high-resolution elapsed measurements. Normal deadlines are 12 ms ahead of the initial anchor; setup/warm-up observations are retained, including a deadline reached during installation.
- **T1:** `status.timing.schedulerEpochMs`, as recorded by the real runtime timer. It may be absent when an observer or arm-time condition dispatches first; the harness does not fabricate it.
- **T2:** `status.timing.receivedEpochMs`, the runtime's receipt of the **arm command**. For browser-owned scheduling it naturally precedes T1; it is not a second transport message at the deadline.
- **T3:** `clicks[0].epochMs`, captured by the fixture's actual document click listener using `performance.timeOrigin + performance.now()`. Runtime `clickEpochMs` is retained separately, not substituted for this independent event.
- Scheduled lateness is **T3 minus the projected T0**. `wallClockEarly` compares the event's integer page `Date.now()` to the actual integer scheduled guard.
- **E0:** the page-local high-resolution timestamp immediately before `disabled=false`.
- **E1:** `status.timing.observerEpochMs`, when supplied by the runtime's actual observer/resize path. The runtime's field can be the most recent observer delivery; it is not necessarily a unique mutation-only receipt.
- **E2:** the independent fixture click timestamp. Reactive latency is **E2 − E0**, entirely within the same page clock.

### Host baselines

`src/benchmark/baseline.ts` pre-resolves the fixture button. The actual `NodeScheduler` waits on a host `Date.now()` guard, then sends either `page.evaluate` or public CDP `Runtime.evaluate` to invoke that resolved button. The same fixture listener records the resulting actual click. Samples preserve host guard/dispatch timestamps and projected scheduler time. These paths measure host scheduling plus browser transport plus local click dispatch, not raw timers, trusted Playwright input, or FlashAct reactive behavior. No Aside CDP baseline is attempted.

Host samples now explicitly include **T2 = `sample.receivedEpochMs`**, captured with the page's high-resolution clock immediately before invoking the cached button's click. The browser response is parsed through `baselineReceiptSchema`, which requires receipt timing and a typed click ledger. It is a **dispatch receipt**, not the browser runtime's earlier arm-command receipt. All **1,000 Node and 1,000 CDP samples contain finite T2**, with T2 ≤ the actual event T3 in every sample. T1 is `sample.schedulerEpochMs` (host callback projected into page time); T0 and T3 retain their earlier meanings. Cross-process T2−T1 remains subject to reported clock uncertainty; page-local T3−T2 does not need host clock alignment.

## Smaller scenarios and exact outcomes

Each browser backend executed **20 trials per row**. Click counts and failure counts remain in the raw reports; expected safety failures are not silently relabeled as successful actions.

| Scenario | Playwright outcome | Aside outcome | Interpretation |
| --- | --- | --- | --- |
| AND, time first | 20 clicks / 0 failures | 20 clicks / 0 failures | Time reaches deadline; enabling happens later. |
| AND, element first | 20 clicks / 0 failures | 20 clicks / 0 failures | Element enabled before scheduled deadline. |
| OR | 20 clicks / 0 failures | 20 clicks / 0 failures | Enable condition wins before the future timer. |
| Simultaneous conditions plus repeated arm | 20 clicks / 0 duplicates | 20 clicks / 0 duplicates | AND timer/mutation delivery around deadline and repeated arm remain single-shot. |
| Selector replacement | **0 clicks / 20 FAILED** | **0 clicks / 20 FAILED** | Cached target removal rejects dispatch rather than clicking the replacement. This is the expected safety result. |
| Page-main-thread CPU contention | 20 clicks / 0 failures; p99 **18.500 ms** | 20 clicks / 0 failures; p99 **53.400 ms** | A 30 ms page-local busy loop deliberately blocks a deadline 12 ms ahead. |
| Additional foreground tab | 20 clicks / 0 failures; p99 **2.000 ms** | 20 clicks / 0 failures; p99 **2.000 ms** | Both measured pages still reported **visible**. Actual hidden-tab throttling is **NOT VERIFIED**. |

**The Aside CPU p99 of 53.4 ms misses a 50 ms threshold.** This is an observed failure of such a latency goal, despite successful single-shot delivery. The deliberately blocked page main thread cannot execute its observer, timer callback, layout/visibility work, or click listener while queued work is stalled. Those are plausible contributors to the tail; this run has no tracing that attributes the exact outlier among them. A Rust/native host scheduler could reduce host timer or transport overhead, but **will not unblock the target browser main thread** and is not a fix for this target-side contention.

Lifecycle evidence is separate from latency statistics (its empty statistics row is not a failed timing run):

- Playwright: adapter disconnect/reconnect on the same owned page succeeded. A future scheduled job was `WAITING`, then **`INVALIDATED`, executions 0**, after actual page closure. This probe passed in browser, Node, and CDP reports.
- Aside: a real future job was `WAITING`, executions 0. `closeTab` disposed the owned page; evaluating that closed handle failed with a disposed-page error. A new owned fixture tab started without a runtime and got a **different documentId** on installation. Both tabs were closed through official `closeTab`. This proves fresh-document reconnection, **not automatic job restoration** or queryable terminal state after destroying the old realm.
- Both browser reports record 2,140 per-trial cancellation acknowledgments. Node/CDP reports record 1,000 timer cancellations; the CDP session was detached in `finally`. Owned Chromium browsers and ephemeral fixture servers were closed. Aside additionally closed its foreground and reconnection fixture tabs. No user tab was read, clicked, navigated, or closed during these runs.

The first Aside adapter-owned multi-command attempt could not reattach its newly opened tab after the one-shot REPL owner exited. The final accepted Aside run therefore uses the adapter lane's **official `AsideTransport` process runner in one independent REPL session**. It is not a claim that multi-command Aside tab ownership is fixed. A supplied `tabId` is supported only for an explicitly provided task-owned local benchmark fixture and is left open; that optional path was **NOT VERIFIED** in this run.

## Standalone timer evidence is separate

The independently generated [`node-timer.json`](../artifacts/benchmark/node-timer.json) measures **raw Node `setTimeout`, not NodeScheduler or browser dispatch**. It contains 1,000 idle trials and 1,000 event-loop-contention trials (5 ms timer, 8 ms busy loop):

| Raw timer run | Mean | p99 | Failures under that artifact's definition | Early callbacks |
| --- | ---: | ---: | ---: | ---: |
| Idle | 0.583 ms | 0.898 ms | 22 | 22 |
| CPU/event-loop contention | 3.052 ms | 3.152 ms | 0 | 0 |

Its success definition is callback lateness within [0, 50] ms and differs from click-delivery success above. Do not merge those rates, treat the idle early callbacks as NodeScheduler behavior, or claim full-machine CPU saturation.

## Reproduction

For source checks, run from the repository root. The coordinator's current npm `files` list now ships **dist, docs, examples, and `scripts/serve-fixture.mjs`**. `serveFixture` reads `new URL('../../examples/local.html', import.meta.url)`, so compiled and source modules resolve the asset relative to their package, **not the caller's cwd**. Installed fixture commands are therefore runnable from another directory.

```sh
npm run build
npm run typecheck
npm test -- tests/unit/benchmark.test.ts tests/integration/benchmark-fixture.test.ts

# Independent local fixture; prints an ephemeral localhost URL. Ctrl-C closes it.
node scripts/serve-fixture.mjs
```

### Installed fixture and first harmless clicks

The previous installed-prefix invocation reproduced `ENOENT .../flashact-install.ef5fSn/examples/local.html`. After the module-relative fix, these packaging commands were actually executed (no publish, no root manifest edits):

```sh
npm pack --ignore-scripts --pack-destination /var/folders/2z/6tvknkjs6n58ztj44vq231nr0000gn/T/opencode
npm install --prefix /var/folders/2z/6tvknkjs6n58ztj44vq231nr0000gn/T/opencode/flashact-install.ef5fSn \
  --ignore-scripts --offline /var/folders/2z/6tvknkjs6n58ztj44vq231nr0000gn/T/opencode/flashact-0.1.0.tgz
```

The corrected installed module started from the unrelated `/private/var/.../T/opencode` cwd, served `http://127.0.0.1:59849/local.html?ready=1` with **HTTP 200**, and closed its server. Actual installed CLI schedule and watch processes each reached **`VERIFIED`, executions 1**, then exited **code 0** after SIGTERM. Each used its own temporary `FLASHACT_HOME`, launched/closed only its own Chromium, and required no DevTools. Full command arguments, statuses, timing and cleanup receipts are in `fixture-installed.json`.

For a fresh manual run, start the fixture in one terminal (set `PACKAGE_DIR` to the installed `node_modules/flashact` directory):

```sh
node "$PACKAGE_DIR/scripts/serve-fixture.mjs"
```

Copy its printed URL into `FIXTURE_URL`. In another terminal, approve **only this local fixture**:

```sh
CLI="$PACKAGE_DIR/dist/cli/index.js"
DEMO_HOME="$(mktemp -d)"
export FLASHACT_HOME="$DEMO_HOME"

# Authored button is immediately enabled; schedule five seconds ahead.
URL="${FIXTURE_URL}?ready=1"
AT="$(node -e 'process.stdout.write(new Date(Date.now()+5000).toISOString())')"
node "$CLI" schedule --launch --headless --url "$URL" --approved-url "$URL" \
  --selector '#reserve' --action click --at "$AT"
# After VERIFIED, press Ctrl-C; the CLI stays foreground until stopped.

# Authored page enables the button after five seconds; no console injection.
URL="${FIXTURE_URL}?enableAfter=5000"
node "$CLI" watch --launch --headless --url "$URL" --approved-url "$URL" \
  --selector '#reserve' --action click --when '#reserve:enabled'
# After VERIFIED, press Ctrl-C, then remove only this task's temporary home.
rm -rf "$DEMO_HOME"
unset FLASHACT_HOME
```

Then stop the fixture terminal with Ctrl-C. No tab discovery, personal-browser attachment, or form submission is involved. `enableAfter` accepts only integer decimal digits in **[0, 60000]**; negative, fractional, malformed, empty, and over-limit values leave the button disabled. Without a query the original disabled default remains unchanged. A benchmark `reset()` cancels the optional activation timer and takes ownership of fixture state.

The actual measured invocation used the compiled API, sequentially:

```sh
node --input-type=module -e '
import {runBenchmark} from "./dist/benchmark/index.js";
for (const mode of ["browser", "node", "cdp"]) {
  const report = await runBenchmark({mode, iterations:1000,
    output:`artifacts/benchmark/playwright-${mode}.json`});
  console.log(JSON.stringify({backend:report.backend,mode,
    results:report.results.map(r=>({scenario:r.scenario,summary:r.summary,
      evidence:r.evidence,clockCalibration:r.clockCalibration,visibility:r.visibility})),
    teardown:report.teardown}));
}
const report = await runBenchmark({backend:"aside",iterations:1000,
  output:"artifacts/benchmark/aside-browser.json"});
console.log(JSON.stringify({backend:report.backend,
  results:report.results.map(r=>({scenario:r.scenario,summary:r.summary,
    evidence:r.evidence,visibility:r.visibility})),teardown:report.teardown}));
'
```

The follow-up reran **only** the loop's `node` and `cdp` modes, with `iterations:1000` and the same output paths. It left `playwright-browser.json`, `aside-browser.json`, `node-timer.json`, and the separate hidden-tab worker's files untouched.

`src/benchmark/index.ts` exports `runBenchmark`, `BenchmarkOptions`, and `BenchmarkReport`. API defaults are `playwright`, `browser`, **1,000** iterations. Options are parsed at the boundary, including callers passing decoded unknown JSON. The CLI may supply its own iteration default; use an explicit count when comparing reports. External `endpoint` attachment is deliberately rejected to keep benchmarks off personal/external browsers. Aside Node/CDP modes are rejected. The public `headless` option configures only launched Playwright browsers.

## Verification and limits

- `npm run build`: **passed** with actual runtime, adapters, CLI and MCP sources present.
- `npm run typecheck`: **passed** for the full source/test configuration.
- `npm test -- tests/unit/benchmark.test.ts tests/integration/benchmark-fixture.test.ts`: **17 tests passed**: six unit tests and eleven fixture integration cases. Tests cover required T2 payloads, subprocess unrelated-cwd HTTP/close behavior, ready/default state, bounded activation, invalid delays, and reset cancelling activation. Timed query tests control only the page clock; the installed CLI watch demo additionally exercised the real five-second timer.
- Standalone `node scripts/serve-fixture.mjs` was launched as PID 70478, served `http://127.0.0.1:58746/local.html` with HTTP 200 / `text/html; charset=utf-8`, then exited **code 0** on SIGTERM after closing its server.
- All four 1,000-trial benchmark runs completed successfully; browser edge and lifecycle evidence are in the reports, with successful teardown receipts.
- Screenshot confirmation: the saved Aside image was opened and shows the local fixture and its 2,120-event ledger.
- Follow-up changed code files contain **33–66 nonblank/noncomment lines**; responsibilities remain asset serving, host measurement, payload/statistics, authored fixture state, and behavior tests. JSON responses are parsed at their boundary; no type assertions or non-null escape hatches were introduced.
- LSP diagnostics were requested, but the TypeScript LSP is **not installed**, and installation was previously declined. **LSP cleanliness is NOT VERIFIED**; the strict TypeScript build passed instead.
- The initial benchmark audit could not run because its provider key was unavailable. The integrated v0.1 implementation subsequently received independent approval in `artifacts/qa/gate-review-final.json`; that approval is not a certification of every timing/environment condition or of the follow-up experiment below.
- **Windows, actual hidden/background-tab timer throttling, full-machine CPU saturation, sleep/wake, clock jumps, and long-horizon scheduling are NOT VERIFIED** by this harness run.
- Clicks are **untrusted synthetic DOM events** (`isTrusted:false`). Neither `VERIFIED`, a ledger receipt, nor low observed latency implies trusted input, a network request, site acceptance, reservation success, or a future timing guarantee.

## Follow-up: seconds-ahead visible scheduling

The next verification used the same compiled browser-runtime SHA-256
`769c2a5ffccd595d014de36c74c9a132019696f04cb311dd37c59e64ff16a391`.
Production `src/**`, package metadata and `flashact-0.1.0.tgz` were not changed.
All original 1,000-trial reports were preserved byte-for-byte.

### Native hiding remained blocked

`scripts/hidden-state-probe.mjs` used only newly owned headful Chromium windows
and public CDP `Browser.getWindowForTarget`, `Browser.getWindowBounds`, and
`Browser.setWindowBounds`. The primary and secondary pages had the **same**
native window ID, refuting the different-window hypothesis for these runs.

The minimize request returned success, but after a bounded five-second wait the
window still reported `normal` and both raw CDP and Playwright reported native
`visible`, `document.hidden === false`. There were zero visibility transitions.
The parent reproduced the same failure. Restoration matched the original bounds;
both CDP sessions, context, browser and fixture server closed.

This is **BLOCKED / zero hidden trials**, not evidence that background timing
passes or that hiding is impossible in every configuration. Complete launch
arguments could not be retrieved: the public command-line getter rejected the
request because `--enable-automation` was absent. Requested launch options are
recorded, but the complete actual argument list is **NOT VERIFIED**.
Raw evidence: `artifacts/benchmark/hidden-state-probe.json`.

### Final serial visible-only run

The parent ran `node scripts/visible-latency-benchmark.mjs` after the other browser
experiment had finished. All 25 actual trials were natively visible and produced
exactly one fixture click and `VERIFIED` runtime status. No replacements were run.

| Scenario | Trials | Mean ms | Median ms | Min ms | Max ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Scheduled, 12 ms ahead | 10 | 0.750 | 0.850 | -0.200 | 1.800 |
| Scheduled, 1 second ahead | 5 | 1.020 | 1.200 | -0.100 | 1.800 |
| Scheduled, 8 seconds ahead | 5 | 5.680 | 0.900 | -0.200 | 25.600 |
| Reactive, page stimulus scheduled 1 second after ARM | 5 | 0.320 | 0.300 | 0.200 | 0.500 |

Failures, duplicate clicks and wall-clock early-guard violations: **0**.
Three negative projected scheduled deltas were within their recorded clock
uncertainty; none exceeded it. No observed delay exceeded 50 ms in this run.
These small cells provide descriptive statistics, **not population P99 or an SLA**.
The eight-second cell contains one substantially later sample; its maximum is
retained, and no unmeasured cause or optimization benefit is inferred.

Scheduled expiry is target wall-clock deadline **plus 3 seconds**, not ARM time
plus 3 seconds. Reactive E0 is measured immediately after the real native
`disabled=false` setter, with its before/after interval retained. E1 is the runtime
observer timestamp only when available after E0; that field can also originate
in ResizeObserver and is not independent mutation-only attribution. E2 is the
independent fixture click event. Intended stimulus deadline and actual stimulus
timer lateness are separate fields; reaction latency is **E2 - actual E0**.

Raw report: `artifacts/benchmark/visible-latency.json`. The original matrix
planned 50 trials: **25 visible completed, 25 hidden skipped / NOT VERIFIED**.
The first writer run detected a changed probe report during the parent's separate
reproduction and correctly reported incomplete preservation. The final parent
run was serial: all five baseline reports, the probe report and the tarball had
matching before/after hashes, with no errors. CDP detached; page/window, context,
browser and loopback fixture listener all closed.

Reproduce without another browser experiment running concurrently:

```sh
npm run build
node scripts/visible-latency-benchmark.mjs
npm test -- tests/unit/visible-latency.test.mjs
```

Independent evidence audit: `artifacts/qa/native-latency-review.json` returns
**APPROVE_EVIDENCE** for the recorded visible-only partial experiment, not for
hidden operation or an SLA. It independently recomputed all 25 raw rows and
before/after hashes. Default regression tests passed **293 cases**, with the
existing six opt-in live Aside cases skipped in this measurement-only follow-up;
no new skip was introduced. Source/typecheck and script syntax checks passed.

The audit identified an interruption race: `Promise.race` did not cancel/join
the producer or pending acquisition. That experimental harness has since been
corrected with cooperative stopping, owned-resource disposal and joined report
finalization. See [Cooperative Benchmark Stop](benchmark-stop.md) for the RED
reproductions, real SIGINT/watchdog controls, output protection and bounded
guarantees. The previously accepted 25-row timing dataset remains unchanged;
tested local fault paths are not a universal SIGKILL/OS/unreachable-operation
cleanup guarantee.

## Follow-up: controlled probe shutdown

On 2026-10-13 the controlled Chrome probe's shutdown hang was repaired and
verified with an owned SDK worker, protocol request-ID records and actual
SIGINT/watchdog controls. The normal run finalized with no errors,
`cleanupSuccess=true` and unchanged protected hashes. Native hiding still failed,
so its status remains `BLOCKED` and hidden trials remain zero.

See [Controlled probe shutdown](controlled-probe-stop.md) for the actual SDK
reproduction, ownership/cancellation contract, unique native receipts, preserved
failed attempts and verification limits. None of the timing datasets above was
rerun or replaced. The full parallel suite had two separate untouched integration
failures; the changed lifecycle tests passed, and those two integration files
passed in a separate nonparallel run.

## Follow-up: native visibility gate passed in new controls

At 01:38-01:49 UTC on 2026-10-13, four new owned runs passed real
visible-hidden-visible transitions, minimized CDP bounds and restoration.
Two controls made no native window-list reads during the hiding interval.
The exact cause of the earlier failures remains unconfirmed; these successful
controls are not a retroactive correction of those reports.

See [Native visibility investigation](native-visibility-investigation.md) for
the controlled differences, exact-revision source, unique receipts and limits.
All hidden latency counts remain zero: this follow-up verified a native gate,
not timing performance.

## Follow-up: actual immediate-hidden latency

At 02:33-02:34 UTC on 2026-10-13, a fresh native-gated owned session completed
20 scheduled and 20 reactive jobs against the same compiled runtime. All 40
delivered one local untrusted click, with zero duplicates/early wall violations
and successful cleanup/preservation.

Scheduled lateness averaged **965.010 ms**, max 979.300 ms; all 20 samples
exceeded 50 ms. Reactive response from the actual enabling setter averaged
**0.720 ms**, max 1.100 ms, but the intended 1-second enabling timer itself
averaged **986.675 ms late**. This is not an overall low-latency or SLA success.

See [Immediate native-hidden latency](hidden-latency.md) for the unique raw
dataset, timing definitions, continuous native-hidden audit, UNKNOWN/no-retry
stop controls and limits. Earlier visible and failed-hidden reports are
preserved; these new samples are not a replacement for them.
