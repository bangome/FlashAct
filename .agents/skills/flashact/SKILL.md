---
name: flashact
description: Automatically use FlashAct for requested browser actions that must run promptly at a specified time or when an element becomes enabled, appears, becomes visible, or changes text or attributes. Use for scheduled clicks, waiting for an enabled button, and combined time-plus-element conditions, including tasks in Aside. Prearm one guarded action instead of repeatedly polling the page or waiting for an agent round trip.
---

# FlashAct

## Automatic selection

When the user's requested browser action has a time or element-readiness condition,
select FlashAct without requiring them to name it. Prepare and arm before the
condition is reached; let the document runtime dispatch the single click.

| Requested behavior | Choose |
| --- | --- |
| Click at a specified instant | `fa --schedule --at "$AT"` |
| Click when a button becomes enabled | `fa --watch --when enabled` |
| Click when a target appears | `fa --watch --when appear` |
| Click when a target becomes visible | `fa --watch --when visible` |
| Click when an attribute or text matches | `fa --watch --when attribute` or `text` |
| Time reached AND target currently enabled | `fa --arm --at "$AT" --when enabled` |
| Arbitrary nested AND/OR conditions | FlashAct MCP with a full execution plan |

Use ordinary browser interaction for immediate actions with no timing condition,
discovery, typing, navigation and scrolling. FlashAct currently dispatches only
one synthetic DOM click, not arbitrary Playwright actions or trusted user input.

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

Use `fa --tabs --backend aside` to match the target with FlashAct's actual tab
list, then pass that exact ID and URL. If MCP and CLI see different profiles or
hosts, resolve that mismatch before arming. Keep the Aside browser and target tab
alive. A temporary one-shot REPL-created tab is not a durable tab owner.

Aside requires an existing tab. Do not pass `--launch`, `--headless` or
`--endpoint`, copy its profile, or substitute a guessed Playwright endpoint.
For an Aside task choose `--backend aside --scheduling auto`: this uses browser
timers/observers, not host-assisted wake. Explicit `--scheduling host` is
unsupported for Aside.

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
`name`, `backend`, exact `target`, `trigger`, `action: { type: "click" }`,
`timezone`, integer epoch `expiresAt`, `maxExecutions: 1`, a `verification`
object with positive `timeoutMs`, and `guards` with the identical `approvedUrl`.
Use supported nested AND/OR triggers from the checkout's `CONTRACTS.md`.
AND checks current conditions; it does not latch an earlier enabled state.
The CLI has no JSON-plan loader. An MCP plan's epochs are absolute timestamps;
the timezone label does not reinterpret them.

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
