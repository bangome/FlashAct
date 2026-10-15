# FlashAct

Single-shot browser DOM clicks triggered by a scheduled instant, an element condition, or a combination of conditions. FlashAct is a Node.js 22 / npm project, not a browser extension, daemon, or guaranteed reservation service.

Text-image CAPTCHA waiting can be armed independently with `--watch --action
captcha --when appear --captcha-image <css> --captcha-input <css>`. Local macOS
Vision OCR prepares before waiting, then fills once when the image is ready;
no opener or image click is required. The post-click companion remains supported.
Explicitly configured submission requires success verification. This is not
general screen understanding; see
[CAPTCHA configuration](docs/captcha.md).

**Safety boundary:** the browser runtime calls `HTMLElement.prototype.click.call(element)`. This generates an **untrusted synthetic DOM event**, not trusted browser input or a physical gesture. A click receipt does not establish site acceptance, payment, reservation, or network success. Use a meaningful verification selector and independently verify consequential outcomes. `UNKNOWN` is terminal; it must not cause an automatic retry. Every plan requires `maxExecutions: 1`.

## Repository readiness

The local service build includes owned adapter lifetimes and guarded host scheduling for CLI/MCP. On October 13, 2026, actual hidden CLI and stdio MCP each passed 20 authored localhost HTTP-acknowledged actions, with no early or duplicate request. Their means were 4.81 ms and 6.05 ms with five-second scheduling lead. These are measured populations, not a real-site or latency guarantee. Historical live Aside and packed MVP evidence remains under `artifacts/qa`; current service evidence is under `.omo/evidence/service-use-20261013`.

## Install and build locally

Historical baseline verification (2026-10-13): the unchanged default parallel test
configuration passed **435 tests across 34 files**, with six existing opt-in
live Aside cases skipped, and strict typecheck passed. Clock-sensitive test
setup and current-runtime stop-test preconditions were stabilized without
changing product behavior or historical evidence. See
[parallel stabilization evidence](.omo/evidence/parallel-stabilization-checks.md).
This does not repeat the earlier packed-install or live Aside certification.

Current service build verification: strict typecheck/build and the normal
parallel suite passed **518 tests**, with the same six opt-in live Aside skips.
Actual CLI/MCP hidden populations, lifecycle faults and fresh installed-package
checks are described in [service use](docs/service-use.md).

Use Node **>=22.12.0 and <23**, npm >=10 (the package pins npm 10.9.7). From the repository directory:

```sh
npm install
npm run build
npx playwright install chromium
npm run typecheck
npm test
```

The tested environment is Node v22.22.2 on macOS. The default suite skips six opt-in live Aside cases. With the official Aside CLI/browser running, `FLASHACT_ASIDE_INTEGRATION=1 npm test` includes those cases; this service acceptance did not rerun live Aside.

After a successful build with a CLI entry point, inspect the local build rather than fetching a published package:

```sh
node dist/cli/index.js --help
node dist/cli/index.js --version
```

The program help name is `fa`; current commands use `fa --<command>`. The
legacy `flashact` bin and bare subcommands remain supported. The npm package
name stays `flashact`, and MCP tool names stay `flashact_*`.

Pack and test installation locally; **do not publish**:

```sh
mkdir -p candidate-package
npm pack --pack-destination candidate-package
npm install --prefix candidate-install ./candidate-package/flashact-0.1.0.tgz
./candidate-install/node_modules/.bin/fa --help
./candidate-install/node_modules/.bin/fa --version
```

Use fresh candidate directories and the filename printed by npm pack; preserve
older tarballs. `prepack` builds dist. The package includes dist, docs, examples
and its fixture script. Add the candidate bin directory to PATH or use its
absolute path from another working directory. No registry publication is needed.

## First harmless scheduled and reactive clicks

These POSIX-shell examples use only the authored local fixture: `#reserve` is a harmless `type="button"`, with no form, account, purchase, or service API. No personal browser, DevTools endpoint, or tab-ID discovery is required. From the repository, start the fixture in **terminal A** and leave it running:

```sh
node scripts/serve-fixture.mjs 3000
```

The script serves `http://127.0.0.1:3000/local.html`; if port 3000 is occupied, choose another port and use its printed URL. From an installed package, invoke the shipped script by its package path. In **terminal B**, after the local install above (or invoke the built CLI as `node dist/cli/index.js --schedule`):

```sh
URL='http://127.0.0.1:3000/local.html?ready=1'
AT="$(node -e 'process.stdout.write(new Date(Date.now()+15000).toISOString())')"
fa --schedule --launch --headless --url "$URL" --approved-url "$URL" \
  --at "$AT" --selector '#reserve' --action click
```

`?ready=1` enables the button on load. The future offset-ISO timestamp schedules one local synthetic click. Browser startup consumes some lead time; recompute `AT` immediately before starting if necessary. The command emits JSON lifecycle statuses and a generated job ID. After the terminal status, **press Ctrl-C and wait for exit before starting watch**: it remains foreground even after `VERIFIED`, and only one owner may claim a control home.

```sh
URL='http://127.0.0.1:3000/local.html?enableAfter=5000'
fa --watch --launch --headless --url "$URL" --approved-url "$URL" \
  --selector '#reserve' --action click --when '#reserve:enabled'
```

`?enableAfter=5000` lets the page's authored timer enable the button after five seconds; no console injection is needed. `enableAfter` accepts decimal integers from 0 to 60000; without a valid activation query the button stays disabled. After its terminal status, stop watch with Ctrl-C; then stop the fixture in terminal A. For combined execution, `--arm` requires both `--at "$AT"` and `--when '#reserve:enabled'`, plus the same launch/URL/approval/selector/action flags, and evaluates them with AND.

While an action owner runs, **terminal C** can query or cancel it:

```sh
fa --status
fa --status JOB_ID
fa --logs
fa --cancel JOB_ID
```

Replace `JOB_ID` with emitted output and use the same `FLASHACT_HOME`. Cancellation is not an undo operation. Add `--verify-selector <css> --verify-timeout-ms 5000` for meaningful post-action evidence; when omitted, `VERIFIED` certifies only local synthetic dispatch.

## CLI command reference

`--doctor`, `--connect`, `--tabs`, `--inspect`, `--schedule`, `--watch`, and `--arm` share `--backend <backend>` (default `playwright`), `--tab <id>`, `--url <url>`, `--endpoint <endpoint>`, `--launch`, and `--headless`. Aside rejects launch/headless and requires an explicit existing tab for inspection/execution. For each command, consult its implemented help before use:

| Help invocation | Source-defined syntax and behavior |
| --- | --- |
| `fa --help` | List actual commands and global options. |
| `fa --version` | Report package version. |
| `fa --doctor --help` | Reports Node/OS/package/Aside diagnostics; currently probes Aside regardless of selected backend. |
| `fa --connect --help` | Connect, print tabs, and disconnect; not a durable session. |
| `fa --tabs --help` | Connect, enumerate tab IDs, and disconnect. |
| `fa --inspect --help` | Requires `--selector <selector>`; inspect the selected exact tab. |
| `fa --schedule --help` | Requires `--at <time>`, `--approved-url <url>`, `--action click`, and a target selector. Immediately validates/arms; stays foreground. |
| `fa --watch --help` | Requires `--when <condition>`, `--approved-url <url>`, `--action click`, and a target selector. Immediately validates/arms; stays foreground. |
| `fa --arm --help` | Requires both `--at <time>` and `--when <condition>` plus approval/action/selector; combines them with AND. Not a JSON file loader. |
| `fa --status --help` | `--status [jobId]`; queries all jobs if omitted. |
| `fa --cancel --help` | `--cancel <jobId>`; request cancellation before dispatch. |
| `fa --logs --help` | `--logs`; read bounded lifecycle logs. |
| `fa --benchmark --help` | `--iterations <count>` (default 10), `--backend <backend>` (playwright), `--mode <mode>` (browser/node/cdp, default browser), `--output <path>`, `--tab <id>`. |
| `fa --mcp --help` | Stdio server; `--launch`, `--headless`, `--url <url>` or `--endpoint <endpoint>` configure Playwright only. |

Action commands accept `--scheduling auto|browser|host` (default `auto`), `--verify-selector <css>` and `--verify-timeout-ms <integer>` (default 5000), plus selector, irreversible approval, timezone, attribute/value and foreground flags. Conditions are enabled/appear/visible/attribute/text; selector shorthand is supported. `--at` accepts wall-clock time or explicit-offset ISO. Scheduled plans expire 60 seconds after their deadline and reactive plans after 24 hours. There is no JSON-plan loader, expiry or watch-root flag; MCP accepts full plans.

`connect` and `tabs` do not share a persistent connection with later invocations. Prefer CDP attachment with the stable tab ID returned by `tabs` when using separate commands; launch-local IDs are not reusable across processes. `status`, `cancel`, and `logs` use authenticated localhost control in `src/cli/ipc.ts`.

For repeated Aside preparation, reuse `fa --mcp`: its owned control connection
keeps the official Aside MCP process alive and reads live typed target state
without repeated snapshots. Foreground actions publish runtime changes instead
of polling every 100 ms; waiting readers do not block cancellation.
See [read and confirmation evidence](docs/read-confirmation.md).

After approving a harmless local fixture, these source-matched examples show the syntax (replace the endpoint/tab/URL/time):

```sh
fa --tabs --backend playwright --endpoint http://127.0.0.1:9222
fa --inspect --endpoint http://127.0.0.1:9222 --tab APPROVED_TAB_ID --selector '#reserve'
```

Run only one action owner per control home. In a second terminal use `fa --status`, `fa --logs`, or `fa --cancel JOB_ID` with the emitted job ID. Action commands stay alive **even after a terminal result** until SIGINT/SIGTERM; stop them explicitly when finished. These are syntax examples, not commands executed by this documentation task.

## Optional text-image CAPTCHA

Action commands accept `--captcha-image <css>` and `--captcha-input <css>`
together for one local text-image CAPTCHA after the original click. Optional
`--captcha-submit <css>` requires `--captcha-success <css>`; submission is never
implicit. Additional flags are `--captcha-length` (1..32, default 6),
`--captcha-alphabet` (`uppercase-alphanumeric` by default, `alphanumeric`, or
`digits`), `--captcha-min-confidence` (0..1, default 0.8), and
`--captcha-timeout-ms` (100..120000, default 15000). Partial configurations and
dangling CAPTCHA flags reject.

The default recognizer needs macOS and Swift and prepares/compiles native Vision
before arming; no API keys or model downloads are needed. Detection is preinstalled
and event-driven, gated on the original click; OCR uses cropped image pixels.
With a primary `--verify-selector`, its default timeout becomes at least the
CAPTCHA timeout plus 2000 ms (minimum 5000 ms); an explicitly smaller timeout
than the CAPTCHA timeout rejects.

Read nested `status.captcha`, including confidence, error and stage timing,
separately from main `state`/`executions`. Main click `VERIFIED` never establishes
CAPTCHA success. Stale images, ambiguous targets, filled inputs and text outside
confidence/alphabet/length constraints are refused. No text/images appear in
status or logs; no retry, reconnect or rearm occurs. Grid, slider and third-party
iframe challenges are unsupported, and success is not guaranteed.
See [CAPTCHA configuration and outcomes](docs/captcha.md) for exact selectors,
CLI/MCP examples and SDK exports.

## Safe execution workflow

1. Use a task-owned local fixture first. Connect explicitly, list tabs, then select the exact returned tab ID. Playwright supports an explicit CDP endpoint or explicit launch through adapter options; it does not automatically connect to a personal browser.
2. Inspect the target without clicking. Confirm the exact live URL, selector uniqueness, visibility/enabled state, and action consequences. Existing tabs must not be navigated, clicked, or injected with an armed runtime until approval identifies that **exact URL and target**.
3. Adapt one of the JSON examples below. Set a real tab ID, live exact URL in both URL fields, an appropriate future deadline and expiry, and a meaningful verification selector. Review and approve the plan before arming.
4. Keep the foreground process owning the engine and browser connection alive while waiting and verifying. Run cross-process status/cancel/log requests from a second terminal against the same control home. No background daemon, restart persistence, or crash recovery is promised.
5. Inspect the terminal result. `VERIFIED` is local evidence only. If the result is `UNKNOWN`, investigate manually; do not re-arm or create a duplicate action automatically. Cancelling after dispatch cannot undo the action.

The control home defaults to `~/.flashact`, overridden by `FLASHACT_HOME`. `engine.json` records a loopback port, owner PID, and random bearer token. Treat it as a secret: do not paste it into logs or share it. One foreground owner can claim a home; a crashed owner's stale metadata requires manual cleanup **only after confirming that owner is gone**.

### Sample plans

| File | Trigger |
| --- | --- |
| [scheduled-click](examples/scheduled-click/plan.json) | One scheduled instant. |
| [event-click](examples/event-click/plan.json) | Target becomes enabled (or is already enabled at arm). |
| [combined-trigger](examples/combined-trigger/plan.json) | **AND**: time reached and target enabled at the same evaluation. |

These templates target the actual `examples/local.html` fixture: `#reserve`, `watchRoot: "body"`, scheduled URL `http://127.0.0.1:3000/local.html?ready=1`, and event/AND URL `http://127.0.0.1:3000/local.html?enableAfter=5000`. Start the fixture first and replace `REPLACE_WITH_APPROVED_TAB_ID` with the ID listed by the **same engine/connection** that will arm it. Both URL fields must match the selected live page exactly. The sample `at: 4102444800000` is **2100-01-01T00:00:00Z**; expiry is one minute later. Replace these epochs with a practical approved future deadline/expiry. The event-only plan can dispatch immediately if enabled before arm. These examples deliberately use only `{ "timeoutMs": 5000 }` for verification: the fixture receipt element exists before clicking and is not a meaningful presence-based success selector. No nonexistent selector is invented. Use full-plan MCP/API input to add a real post-action selector for a different approved fixture/site.

Plans use schema version `1.0`; unknown keys, nulls, and coercions are rejected. Time values are integer epoch milliseconds. `timezone` is a supported `Intl` zone label and never changes the meaning of an epoch. Triggers include `SCHEDULED`, `ELEMENT_APPEAR`, `ELEMENT_ENABLE`, `ELEMENT_VISIBLE`, `ATTRIBUTE_CHANGE`, `TEXT_CHANGE`, `AND`, and `OR`; composites have 1–32 children and a maximum depth of 8. See [CONTRACTS.md](CONTRACTS.md) and [architecture](docs/architecture.md).

## Scheduling and ownership

See [local service use and recovery](docs/service-use.md) for current acceptance
scope and the first-use workflow.

CLI and MCP use owned transports and `auto` scheduling by default. Playwright
plans containing scheduled leaves receive host readiness checks at each distinct
leaf and expiry. Reactive-only plans keep browser scheduling. `browser` disables
host assistance without changing ownership; `host` requires owned transport and
wake support and rejects unsupported Aside plans. Browser guards and current
AND/OR predicates still decide dispatch.

`status.execution` records requested policy, scheduler, transport, browser
ownership and reason. `flashact_list_backends` discovers capabilities without
opening a browser. Aside has owned CLI clients but browser-only scheduling.

SDK `new JobEngine()` and `createAdapter()` retain direct/browser defaults.
Opt in with `new JobEngine({ adapterMode: 'owned', scheduling: 'auto',
adapterOptionsByBackend: { playwright: { launch: true, headless: true } } })`.
`createOwnedAdapter` is also exported. Owned launch requires Darwin or Linux,
installed Playwright Chromium and a fresh private profile. Owned mode rejects
borrowed page/context objects and `userDataDir`. Endpoint attachment owns its
SDK client only, not the existing browser, tab or profile.

Retain the `NodeScheduler` cancellation handle and every resulting wake promise.
Stop future callbacks first; join started RPCs through a caller-owned termination
boundary. A sent evaluation cannot be cancelled by its timer handle. Borrowed
pages in direct SDK mode do not provide bounded shutdown for a pending evaluation.
Use `adapter.wake` for installation binding; root-exported `wakeExpression` is
only a low-level current-realm expression. See [contracts](CONTRACTS.md).

Native hidden comparison and method are recorded in
[hidden scheduling improvement](docs/hidden-scheduling-improvement.md).

## Aside is a separate integration

The coding-agent skill at `.agents/skills/flashact/SKILL.md` is not automatically
an Aside account skill. For Aside's own agent, install a `flashact` user skill at
`<accountRoot>/skills/user/flashact/SKILL.md` using Aside's `skill-creator`
instructions. The account root is profile-specific, for example `~/.aside/u/0`.
Include OCR and CAPTCHA input in its discovery description and have it read the
full installed FlashAct instructions. Existing chats may need an explicit skill
reload or a new task; never rearm an action just to refresh instructions.

The integrated Aside adapter uses official capabilities in separate discovery and attachment steps: `listBrowserTabs()` → approved exact target ID → `attachBrowserTab(targetId)` → `page.evaluate(...)`. Do not copy profiles, guess private CDP endpoints, or replace Aside with Playwright. Keep an ordinary, operator-opened Aside UI tab alive; the adapter attaches rather than owning a new tab. `AsideAdapter` rejects `options.url`, endpoint, launch, and userDataDir because a one-shot `openTab` tab can disappear with its owner. CLI `--url` for Aside is a target URL filter/plan value, not permission to create or navigate a tab; `--tab` is mandatory for inspection/execution.

```sh
fa --tabs --backend aside
fa --inspect --backend aside --tab APPROVED_ASIDE_TAB_ID --selector '#reserve'
fa --watch --backend aside --tab APPROVED_ASIDE_TAB_ID \
  --approved-url 'http://127.0.0.1:3000/local.html?enableAfter=5000' \
  --selector '#reserve' --action click --when '#reserve:enabled'
```

Open that exact harmless URL in Aside yourself first and approve it before arming. It may already be enabled by the time attachment completes. No arbitrary existing tab is mutated by these instructions.

The independently owned [Aside integration report](docs/aside-integration.md) documents a task-local probe: page-side observers/timers survived the installing one-shot CLI call only while another owner kept the attached tab alive; full navigation replaced the runtime. That result does not grant daemon guarantees or permission to mutate other tabs.

## MCP configuration

The required launch target is **`fa --mcp`**, not an invented server executable:

```json
{
  "mcpServers": {
    "flashact": {
      "command": "fa",
      "args": ["--mcp", "--launch", "--headless", "--url", "http://127.0.0.1:3000/local.html?ready=1"]
    }
  }
}
```

Start the local fixture first and ensure the locally installed executable is on the MCP client's PATH. This configuration launches only a task-owned Playwright browser/page; it does not arm a job. For approved Playwright CDP attachment replace the args with `["--mcp", "--endpoint", "http://127.0.0.1:9222"]`; do not also pass `--launch` or `--url`. `--url` requires `--launch`, and launch/endpoint are mutually exclusive. For Aside-only use `["--mcp"]`, select `backend: "aside"` in tools, and provide an existing approved tab ID in the plan. Playwright options are scoped by backend and do not leak into Aside. Exact ten tools (also enumerated by the coordinator's actual MCP check):

| Tool | Input |
| --- | --- |
| `flashact_list_backends` | `{}` |
| `flashact_list_tabs` | `{ backend }` |
| `flashact_inspect_target` | `{ backend, tabId, selector }` |
| `flashact_create_job` | `{ plan }` (full decoded ExecutionPlan) |
| `flashact_validate_job` | `{ jobId }` |
| `flashact_arm_job` | `{ jobId }` |
| `flashact_get_status` | `{ jobId }` |
| `flashact_cancel_job` | `{ jobId }` |
| `flashact_get_result` | `{ jobId }` |
| `flashact_run_benchmark` | `{ options? }` |

Use list tabs → inspect approved target → create → validate → explicit approval → arm → status/result; creation does not arm. `backend` is `playwright` or `aside`. There is no connect tool: startup flags configure the engine's Playwright adapter, while Aside connects independently through its official CLI. Stdio EOF, server close, SIGINT, or SIGTERM triggers cleanup. The MCP process is a foreground owner and starts the same private control server, not a daemon. Stop other owners or assign distinct private control homes before starting it.

## Evidence and limitations

Read the [benchmark report](docs/benchmark-results.md) and [Aside probe report](docs/aside-integration.md). The 1,000-trial Aside short-deadline benchmark used 12 ms deadlines inside one independent official REPL session: scheduled p99 **2.4 ms**, reactive p99 **0.5 ms**. In contrast, the [initial real multi-command Aside timings](artifacts/qa/aside-initial-timing.json) measured an 8-second scheduled click **365.7 ms late**, AND **285.2 ms late**, reactive **0.9 ms**, and OR **0.5 ms**; the [latest integration run](artifacts/qa/aside-adapter.json) records its own observations. Different horizons/session conditions are not interchangeable; neither supports a 50 ms guarantee. The 20-sample Aside CPU-contention case had p99 **53.4 ms**, missing a 50 ms target despite delivery.

The [hidden-tab attempt](artifacts/benchmark/playwright-hidden.json) is **NOT VERIFIED**: headed Chromium with another owned page brought to front still reported native visibility `visible`, timed out, and completed zero trial batches. Owned context/browser/server were closed. It is not hidden-tab latency evidence. The [raw Node timer artifact](artifacts/benchmark/node-timer.json) measures `setTimeout`, not NodeScheduler or browser dispatch. Windows, sleep/wake, and long-horizon precision remain unverified. See [limitations](docs/limitations.md).

The package root exports `JobEngine`, `PlaywrightAdapter`, `AsideAdapter`, `NodeScheduler`, `createAdapter`, `createOwnedAdapter`, `runBenchmark`, and `createMcpServer`, alongside contracts and schemas. Parse decoded plans with `parsePlan`. No registry publication is required.
