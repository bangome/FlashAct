# Limitations and operational safety

## What a click result proves

- FlashAct invokes `HTMLElement.click()` through its prototype. The resulting click is synthetic and `isTrusted` is false. It is not Playwright's trusted browser-input action, a mouse down/up sequence, a physical gesture, or guaranteed transient user activation. Sites can ignore synthetic events, require pointer sequences, or require user activation for privileged APIs.
- `DISPATCHED` records an attempted single action. `VERIFIED` is local runtime evidence: without a verification selector it can mean only a captured local click; with a selector it means that selector was observed. Neither proves HTTP success, a server-side transaction, a reservation, payment, inventory allocation, or eventual consistency.
- Use a unique, meaningful post-action verification selector that is not already satisfied. Presence does not inherently prove visibility, newness, or association with this job. Verify consequential outcomes independently through the site's authoritative UI/receipt.
- `UNKNOWN` is terminal and has **no automatic retry**. A handler error, timeout, disconnect, or navigation can leave the outcome ambiguous. For an armed Aside job, `executions: 0` after loss is the last observed count, **not proof that no click occurred**. Do not automatically create another job to repeat it. `maxExecutions: 1` applies per job, not globally across independently created jobs or restarted owners.

## Timing is best effort

Background tabs can throttle or freeze timers and observers. Browser suspension, OS sleep, power saving, event-loop contention, garbage collection, rendering work, and transport latency can delay execution. Expiry prevents late dispatch when a check runs; it cannot wake a sleeping machine. Wall-clock adjustments can change scheduling behavior. No submillisecond, millisecond, deadline, or availability SLA is provided.

The sample scheduled epoch is deliberately far in the future (2100) to prevent accidental immediate scheduling. It is not a recommended operational deadline. CLI wall-clock parsing must be checked against implemented options; the existing time utility accepts explicit-offset ISO instants or future wall-clock occurrences in an `Intl` timezone, rather than changing the meaning of JSON epoch values.

Read the [actual benchmark report](benchmark-results.md) without equating its different paths or success definitions. Aside's 1,000 short 12 ms deadline trials inside one official REPL session yielded scheduled p99 2.4 ms and reactive p99 0.5 ms. The [initial multi-command timings](../artifacts/qa/aside-initial-timing.json) recorded an 8-second scheduled click 365.7 ms late and AND 285.2 ms late; reactive/OR were 0.9/0.5 ms. The latest live run is separately recorded in `artifacts/qa/aside-adapter.json`. These session/horizon differences matter and do not imply a 50 ms guarantee. The 20-trial Aside page-main-thread CPU-contention p99 was **53.4 ms**, missing that target. A native host scheduler would not unblock the target page's busy main thread.

The [headed hidden-tab attempt](../artifacts/benchmark/playwright-hidden.json) is **NOT VERIFIED**: another owned page was brought to front, native visibility remained `visible`, the check timed out, and zero trial batches completed. Context/browser/server closure is recorded, not hidden latency. The raw Node timer artifact is not integrated browser dispatch. The earlier [Aside probe report](aside-integration.md) has one approximately 399.6 ms-late 15-second timer; it is separate evidence, not the new adapter result or a distribution. No hidden/background throttling, sleep/wake, or long-horizon guarantee follows from these runs.

## Documents, selectors, and DOM replacement

- Reload/full navigation destroys document-scoped work. URL changes can invalidate the runtime even when the tab ID persists. Do not blindly reinstall/re-arm after navigation, disconnection, browser restart, or history restoration.
- The action target is cached after selection/appearance. Replacement with a visually identical DOM element can fail the job rather than click a new element. Removal of the approved watch root also fails. This prevents unapproved retargeting but limits compatibility with frequently rerendered applications.
- Selectors must be valid CSS for the current document. Schema parsing checks nonempty text, not selector syntax. The present document-query approach does not automatically cross iframes or closed shadow roots.
- Enabled and visible checks are DOM heuristics, not complete browser actionability. A visible element can be covered, offscreen, or noninteractive by site logic; a synthetic click is not physical hit testing. Event predicates may already be true at arm and dispatch immediately. `AND` does not remember a condition that was true earlier and became false.

## Approval and irreversible effects

`guards.approvedUrl` must exactly equal `target.url`, and the live URL is checked again before execution. Differences in query strings, fragments, redirects, or trailing slashes matter; the contract does not normalize them. Approval must name the intended URL and target, not merely an origin or an active-tab assumption. Do not mutate existing tabs before this approval.

`allowIrreversible: false` is the safe default in the examples. Current detection covers form-submit/image controls and certain links (download, cross-origin, or non-HTTP(S)), not every side effect in arbitrary JavaScript. A normal-looking button can still buy, delete, submit, or send a request. Inspect actual consequences and obtain explicit approval before setting the flag to true. The flag authorizes a known action; it does not make it reversible or safe. Cancellation cannot undo dispatch.

CAPTCHA solving/bypass, queue bypass, anti-bot evasion, credential theft, hidden endpoint exploitation, and automated repeat attempts are **not included**. Site restrictions and legitimate access rules still apply.

## Foreground ownership, control, and privacy

Keep the owner process and its connection alive through waiting and verification, and explicitly stop it after a terminal result. Localhost status/cancel/log control is authenticated using private metadata, but there is no daemon, durable queue, automatic resume, or guaranteed cleanup after abrupt termination/**SIGKILL**. A command returning is not proof that all page-side work stopped. Conversely, a watcher surviving a one-shot Aside CLI call does not establish ownership after its tab owner exits. The Aside adapter rejects new-tab constructor `options.url`; use an operator-kept-open ordinary Aside UI tab with an approved exact URL/ID.

Only one engine can own a control home. Before manually removing stale `engine.json`, confirm the previous process is no longer running and reconcile possible page-side effects. Do not disclose its token. Owner-only permissions and loopback binding do not isolate against another process running as the same user. Local logs omit free-form transition messages but user-supplied IDs and independently collected output may still disclose information; avoid secrets in plans and IDs.

Use task-owned fixtures and browser resources for testing. A Playwright CDP connection is an explicit separate backend, not evidence of Aside compatibility. Aside integration must use official `listBrowserTabs`, separate approved `attachBrowserTab`, and `page.evaluate`; no profile copy, guessed private endpoint, or Playwright substitute. The independent Aside report deliberately limits its conclusions to the tested ownership arrangement.

## Installation and platform status

The project requires Node 22 and npm. Browser binaries require the separate `npx playwright install chromium` step. npm prepack builds dist and the manifest ships docs/examples/fixture script. Package-relative fixture loading and canonical bin-path handling were verified after local tarball installation. The final installed CLI/MCP execution evidence is in `artifacts/qa/manual-cli.json`; an installed benchmark run from an unrelated cwd is in `artifacts/qa/installed-benchmark.json`. These receipts do not establish behavior on untested platforms.

Windows is considered in the IPC privacy code via a PowerShell ACL setup path, but **Windows has not actually been tested**. POSIX mode checks do not prove Windows ACL enforcement. Shell syntax, local install permissions, browser installation, foreground signal/cleanup behavior, and cross-process control require platform-specific validation. Existing measured artifacts are macOS evidence only.

Historical live Aside certification passed 293 tests; the newer default parallel baseline passed 435 with six opt-in live Aside skips. Current service acceptance is recorded separately under `.omo/evidence/service-use-20261013`. Compiler checks substitute for the unavailable LSP, not clean LSP diagnostics. CLI supports verification-selector/timeout flags; MCP accepts full plans. Neither certifies arbitrary-site success.
