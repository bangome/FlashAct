---
name: "flashact"
description: "Use FlashAct to wait for a text-image CAPTCHA to appear and immediately recognize (OCR) and fill it once, without another agent turn or opener click. Also use for scheduled or element-ready browser clicks and their optional post-click CAPTCHA workflow, including Aside. Read when asked about FlashAct capabilities."
---

# FlashAct

FlashAct supports single-shot clicks, independently armed text-image CAPTCHA
waiting, and an optional post-click CAPTCHA companion. It captures cropped
pixels, runs prepared local macOS Vision OCR and fills once, with optional
explicit submission and success verification. It is not general screen
understanding. CAPTCHA-only waiting needs no opener or image click.

## Automatic selection

When the user's requested browser action has a time or element-readiness condition,
select FlashAct without requiring them to name it. Prepare and arm before the
condition is reached; let the document runtime dispatch the single click.
For a CAPTCHA-only request, prearm `--action captcha --when appear` instead:
prepare OCR before waiting and let the image-ready event start recognition/input.

| Requested behavior | Choose |
| --- | --- |
| Click at a specified instant | `fa --schedule --at "$AT"` |
| Click when a button becomes enabled | `fa --watch --when enabled` |
| Click when a target appears | `fa --watch --when appear` |
| Click when a target becomes visible | `fa --watch --when visible` |
| Click when an attribute or text matches | `fa --watch --when attribute` or `text` |
| Time reached AND target currently enabled | `fa --arm --at "$AT" --when enabled` |
| Arbitrary nested AND/OR conditions | FlashAct MCP with a full execution plan |
| Wait for a text-image CAPTCHA, then recognize and fill once | `fa --watch --action captcha --when appear --captcha-image "$IMAGE_SELECTOR" --captcha-input "$INPUT_SELECTOR"` |
| Original click followed by a text-image CAPTCHA | Add `--captcha-image` and `--captcha-input` to the original action command; see Optional text-image CAPTCHA |

Use ordinary browser interaction for immediate actions with no timing condition,
discovery, general typing, navigation and scrolling. Use the CAPTCHA-only action
for an already-open challenge rather than repeating its original opener click.
Click plans can retain the preconfigured companion. Neither action provides
general Playwright actions or trusted physical user input.

## Preparation

1. Use the installed `fa`; check `fa --version` and the chosen command's `--help`.
   If unavailable, use the known checkout's compiled entry point:
   `node /absolute/path/to/FlashAct/dist/cli/index.js`, with the same dashed commands.
   Build that checkout first if its compiled entry point is missing or stale.
2. Determine the requested backend, exact URL, tab, unique CSS selector, condition,
   timezone/deadline and expected completion evidence from the request and page.
   Fill only genuinely missing decisions; do not ask again for authorization
   already supplied for that exact action.
3. Inspect before arming. Use browser snapshots to discover the selector, then
   `fa --inspect --backend "$BACKEND" --tab "$TAB_ID" --selector "$SELECTOR"`.
   Confirm the live URL, target uniqueness and consequences. For appearance
   triggers, the action target may be absent initially.
   For repeated Aside preparation, keep one FlashAct MCP connection and use
   `flashact_inspect_target` for typed live state after snapshot discovery.
   Do not take another full snapshot merely to check the same known target.
4. Resolve a relative or ambiguous time to an exact offset ISO timestamp and
   communicate it. Do not invent a timezone. Finish connection/validation well
   before the deadline; if preparation misses it, do not silently click late.
5. Choose a new, action-specific completion selector when the page provides one.
   An already-present selector is not proof of this action's success.

## Aside MCP and backend

The supplied Aside MCP configuration is:

```json
{
  "mcpServers": {
    "aside": {
      "command": "/Users/bogyung/.local/bin/aside",
      "args": ["mcp"]
    }
  }
}
```

This server controls Aside; it is not the FlashAct execution server. Use its
advertised tools to read browser guidance, discover tabs and inspect the approved
page. Discover actual tool names instead of assuming an API. For CLI inspection,
read `aside guide` and `aside guide repl` before using `aside repl`.

Aside agent shells may omit the CLI directory from PATH even when the MCP
configuration names its absolute executable. FlashAct launches `aside` from
its process PATH. For this supplied configuration, prefix **each** FlashAct
Aside invocation with `PATH="/Users/bogyung/.local/bin:$PATH"`; a previous
shell tool's `export` need not survive into the next call. For another machine,
use the directory of its verified Aside executable instead.

```sh
PATH="/Users/bogyung/.local/bin:$PATH" fa --tabs --backend aside
```

Keep this prefix when using the compiled Node entry point too. `spawn aside
ENOENT` means the executable is missing from that process's PATH, not a login
failure. A CLI `SecItemCopyMatching -25291` can instead mean that the agent's OS
sandbox blocks keychain IPC even with the same user, Aqua and full-access mode.
Report that distinction; do not reset installation keys or log out. Changing
the account's OS sandbox setting needs the user's approval.

Use `fa --tabs --backend aside` to match the target with FlashAct's actual tab
list, then pass that exact ID and URL. If MCP and CLI see different profiles or
hosts, resolve that mismatch before arming. Keep the Aside browser and target tab
alive. A temporary one-shot REPL-created tab is not a durable tab owner.

Aside requires an existing tab. Do not pass `--launch`, `--headless` or
`--endpoint`, copy its profile, or substitute a guessed Playwright endpoint.
For an Aside task choose `--backend aside --scheduling auto`: this uses browser
timers/observers, not host-assisted wake. Explicit `--scheduling host` is
unsupported for Aside.

With `auto`, `status.execution.scheduler: "browser"` and reason
`"unsupported-host-wake"` are expected for Aside; that reason is not an error
or evidence that dispatch failed. Diagnose the lifecycle state separately.
Status reads renew their 20-second observation lease before Aside's inner
30-second CDP evaluation timeout; renewal never reinstalls or rearms a job.

Owned FlashAct CLI/MCP reuses official Aside MCP control/read sessions.
Foreground publishes runtime changes without a status-poll loop; a pending
event read does not block cancel/control. Read leases renew observation only,
never the action. A lost session stays lost and is not automatically reopened.

For an approved Playwright task, use an explicit endpoint/tab or an owned launch.
`auto` provides host assistance for scheduled Playwright plans when supported.
Do not switch a logged-in Aside task to a different browser just for speed.

## Arm one action

Examples below assume the exact inspected values are in shell variables:
`BACKEND`, `TAB_ID`, `URL`, `SELECTOR`, `AT` and `VERIFY_SELECTOR`.
Use a separate private control home for each foreground owner:

```sh
export FLASHACT_HOME="$(mktemp -d "${TMPDIR:-/tmp}/flashact-job.XXXXXX")"
```

Scheduled click:

```sh
fa --schedule --backend "$BACKEND" --tab "$TAB_ID" \
  --url "$URL" --approved-url "$URL" --selector "$SELECTOR" \
  --action click --at "$AT" --scheduling auto \
  --verify-selector "$VERIFY_SELECTOR" --verify-timeout-ms 5000
```

Enabled target:

```sh
fa --watch --backend "$BACKEND" --tab "$TAB_ID" \
  --url "$URL" --approved-url "$URL" --selector "$SELECTOR" \
  --action click --when enabled --scheduling auto \
  --verify-selector "$VERIFY_SELECTOR" --verify-timeout-ms 5000
```

Time AND enabled target:

```sh
fa --arm --backend "$BACKEND" --tab "$TAB_ID" \
  --url "$URL" --approved-url "$URL" --selector "$SELECTOR" \
  --action click --at "$AT" --when enabled --scheduling auto \
  --verify-selector "$VERIFY_SELECTOR" --verify-timeout-ms 5000
```

Omit `--verify-selector` only when no meaningful completion selector exists;
report that verification then proves local dispatch only. Attribute conditions
require `--attribute "$ATTRIBUTE"`; add `--value "$VALUE"` for an exact attribute
or text match. Enabled/appear conditions already true at arm can dispatch
immediately; use `--arm` when both the future time and current condition matter.

Only add `--approve-irreversible` when the exact irreversible action is authorized.
Keep normal URL, uniqueness, readiness, expiry and single-shot guards intact.

## Composite plans via FlashAct MCP

Start the separate execution server with `fa --mcp`; for Aside, no Playwright
launch or endpoint flag is needed. MCP tool names remain `flashact_*`.

Call `flashact_list_backends`, `flashact_list_tabs` with `backend: "aside"`,
and `flashact_inspect_target` for the selected tab/selector. Then call
`flashact_create_job`, `flashact_validate_job`, `flashact_arm_job` and
`flashact_get_status`/`flashact_get_result`.

Supply a complete decoded plan with `schemaVersion: "1.0"`, a fresh `jobId`,
`name`, `backend`, exact `target`, `trigger`, `action: { type: "click" }` or
`action: { type: "captcha" }`,
`timezone`, integer epoch `expiresAt`, `maxExecutions: 1`, a `verification`
object with positive `timeoutMs`, and `guards` with the identical `approvedUrl`.
Use supported nested AND/OR triggers from the checkout's `CONTRACTS.md`.
AND checks current conditions; it does not latch an earlier enabled state.
The CLI has no JSON-plan loader. An MCP plan's epochs are absolute timestamps;
the timezone label does not reinterpret them.

## Optional text-image CAPTCHA

To wait independently without clicking, use the CAPTCHA-only action:

```sh
fa --watch --backend "$BACKEND" --tab "$TAB_ID" \
  --url "$URL" --approved-url "$URL" --action captcha --when appear \
  --captcha-image "$IMAGE_SELECTOR" --captcha-input "$INPUT_SELECTOR"
```

`--selector` defaults to the configured image and cannot name a different target.
The image may be missing or hidden at arm; wait for visibility and actual image
load before capture/OCR/input. An already-ready image can be processed at once.
MCP uses `action.type: "captcha"`, the same image in `target.selector`, an
`ELEMENT_APPEAR` trigger and the existing `plan.captcha` fields.
Keep the foreground owner alive; no extra agent turn or readiness-poll loop is
needed. Before dispatch the plan expiry bounds waiting; after dispatch the
CAPTCHA timeout applies. Warm OCR before the expected appearance, not afterwards.

For an explicitly requested text-image CAPTCHA after the original click, add
`--captcha-image "$IMAGE_SELECTOR" --captcha-input "$INPUT_SELECTOR"` with exact,
unique selectors on the approved document. Optional `--captcha-submit
"$SUBMIT_SELECTOR"` requires `--captcha-success "$SUCCESS_SELECTOR"` and an
explicitly intended submission with observed, action-specific success evidence.
Without submit, fill once only. Partial configuration and dangling flags reject.

Tuning: `--captcha-length` is 1..32 (default 6); `--captcha-alphabet` is
`uppercase-alphanumeric` (default), `alphanumeric` or `digits`;
`--captcha-min-confidence` is 0..1 (default 0.8); `--captcha-timeout-ms` is
100..120000 (default 15000). A primary `--verify-selector` defaults its timeout
to at least CAPTCHA timeout + 2000 ms, minimum 5000; an explicitly shorter
timeout than CAPTCHA timeout rejects. MCP accepts the same camelCase fields in
`plan.captcha` through existing create/validate/arm tools; discover the schema
with `flashact_list_backends`. No additional tools are required.

Default OCR needs local macOS native Vision and Swift. Prepare/compile before
arm with enough lead time; no keys or downloads. Appearance detection is
preinstalled, event-driven and gated on the chosen action's `executions: 1`;
OCR captures cropped pixels. Refuse stale/changed images, ambiguous targets,
filled inputs and text outside the confidence/alphabet/exact-length limits.
Grid, slider and third-party iframe challenges are unsupported.

Read nested `status.captcha`: PREPARING, WAITING, CAPTURING, RECOGNIZING, FILLED,
SUBMITTED, VERIFIED, FAILED, UNKNOWN or CANCELLED. Main `state`/`executions`
remain the original click lifecycle; main VERIFIED is never CAPTCHA success.
On CAPTCHA-only jobs, `executions: 1` means one workflow dispatch, not a DOM
click or input, and `clickEpochMs` remains absent. Actual inputs remain nested.
FILLED and SUBMITTED also do not establish success. Report nested inputs and
submissions (each 0 or 1), confidence/error and available stage timings
`captureMs`, `recognitionMs`, `inputMs`, `totalMs`, never CAPTCHA text or images.
Keep the owner alive through this outcome. Do not retry, reconnect or rearm;
there is no universal success guarantee. Leave existing user booking tabs intact.
See the checkout's `docs/captcha.md` for configuration and SDK exports.

## Ownership, outcome and cleanup

- Run the foreground owner in a managed background terminal/session. Subscribe
  to its output or completion before waiting; do not use fixed sleeps, a busy
  status-poll loop, raw detached shell jobs, or repeated agent-driven clicks.
- Record the generated job ID. Other commands must use the same `FLASHACT_HOME`:
  `fa --status JOB_ID`, `fa --logs`, `fa --cancel JOB_ID`.
- Cancellation stops waiting work but cannot undo a dispatched click.
  `UNKNOWN` is terminal: reconcile application evidence, never automatically
  rearm, reconnect or create a duplicate job. Count zero is only the observed
  count, not proof that no effect occurred.
- After verification, cancellation or failure, send SIGINT/SIGTERM to the owner
  and await actual exit. CLI action commands remain alive after terminal status.
  For FlashAct MCP, close stdio and await shutdown. Preserve the final status.
- Close only task-created tabs with their actual owner. Leave borrowed Aside
  tabs/browser intact. Remove only the private control directory you created
  after its owner exits; never delete shared metadata or another owner's home.
- Report the exact condition/deadline, chosen backend and `status.execution`,
  observed result and independent application receipt when available.
  Selector verification and synthetic clicks are not server-transaction proof.
  Background throttling, page load and transport latency remain best effort;
  do not promise a universal latency SLA or mark an unrun Aside case as passed.
