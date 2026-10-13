# FlashAct

Single-shot browser DOM clicks triggered by a scheduled instant, an element condition, or a combination of conditions. FlashAct is a Node.js 22 / npm project, not a browser extension, daemon, or guaranteed reservation service.

**Safety boundary:** the browser runtime calls `HTMLElement.prototype.click.call(element)`. This generates an **untrusted synthetic DOM event**, not trusted browser input or a physical gesture. A click receipt does not establish site acceptance, payment, reservation, or network success. Use a meaningful verification selector and independently verify consequential outcomes. `UNKNOWN` is terminal; it must not cause an automatic retry. Every plan requires `maxExecutions: 1`.

## Repository readiness

The integrated MVP includes the browser runtime, Playwright and Aside adapters, foreground CLI, authenticated local control, benchmarks, and a ten-tool MCP server. Build and strict typecheck passed; the full macOS suite, including live Aside integration, passed **293 tests across 27 files**. The packed tarball was installed into an isolated npm prefix and exercised through its actual bin link: schedule, watch, composite execution, cross-process status/cancel, and MCP each produced independently observed local clicks. See [manual CLI/MCP evidence](artifacts/qa/manual-cli.json), [lost-acknowledgement evidence](artifacts/qa/lost-ack-after.json), and the [approved independent review](artifacts/qa/gate-review-final.json). These results do not imply real-site acceptance, a latency SLA, or verified Windows support.

## Install and build locally

Latest local verification (2026-10-13): the unchanged default parallel test
configuration passed **435 tests across 34 files**, with six existing opt-in
live Aside cases skipped, and strict typecheck passed. Clock-sensitive test
setup and current-runtime stop-test preconditions were stabilized without
changing product behavior or historical evidence. See
[parallel stabilization evidence](.omo/evidence/parallel-stabilization-checks.md).
This does not repeat the earlier packed-install or live Aside certification.

Use Node **>=22.12.0 and <23**, npm >=10 (the package pins npm 10.9.7). From the repository directory:

```sh
npm install
npm run build
npx playwright install chromium
npm run typecheck
npm test
```

The tested environment is Node v22.22.2 / npm 10.9.7 on macOS. The default test run excludes the opt-in live Aside suite. With the official Aside CLI installed and its browser running, run `FLASHACT_ASIDE_INTEGRATION=1 npm test` to include all 293 tests. Live integration tests create and close only their own localhost fixture tabs.

After a successful build with a CLI entry point, inspect the local build rather than fetching a published package:

```sh
node dist/cli/index.js --help
node dist/cli/index.js --version
```

Pack and test installation locally; **do not publish**:

```sh
npm pack --dry-run
npm pack
npm install --global ./flashact-0.1.0.tgz
flashact --help
flashact --version
```

Global installation changes the local npm environment and may require appropriate permissions. Use the filename actually returned by `npm pack` if the version changes. `prepack` runs the build; the package includes `dist`, README, CONTRACTS, docs, examples, and `scripts/serve-fixture.mjs`. Installed fixture resolution is package-relative, not dependent on the caller's cwd. Local installation, bin-link execution (including macOS temporary-directory aliases), and an installed `benchmark` invocation from another directory were verified. No npm Registry publication was performed.

## First harmless scheduled and reactive clicks

These POSIX-shell examples use only the authored local fixture: `#reserve` is a harmless `type="button"`, with no form, account, purchase, or service API. No personal browser, DevTools endpoint, or tab-ID discovery is required. From the repository, start the fixture in **terminal A** and leave it running:

```sh
node scripts/serve-fixture.mjs 3000
```

The script serves `http://127.0.0.1:3000/local.html`; if port 3000 is occupied, choose another port and use its printed URL. From an installed package, invoke the shipped script by its package path. In **terminal B**, after the local install above (or replace `flashact` with `node dist/cli/index.js`):

```sh
URL='http://127.0.0.1:3000/local.html?ready=1'
AT="$(node -e 'process.stdout.write(new Date(Date.now()+15000).toISOString())')"
flashact schedule --launch --headless --url "$URL" --approved-url "$URL" \
  --at "$AT" --selector '#reserve' --action click
```

`?ready=1` enables the button on load. The future offset-ISO timestamp schedules one local synthetic click. Browser startup consumes some lead time; recompute `AT` immediately before starting if necessary. The command emits JSON lifecycle statuses and a generated job ID. After the terminal status, **press Ctrl-C and wait for exit before starting watch**: it remains foreground even after `VERIFIED`, and only one owner may claim a control home.

```sh
URL='http://127.0.0.1:3000/local.html?enableAfter=5000'
flashact watch --launch --headless --url "$URL" --approved-url "$URL" \
  --selector '#reserve' --action click --when '#reserve:enabled'
```

`?enableAfter=5000` lets the page's authored timer enable the button after five seconds; no console injection is needed. `enableAfter` accepts decimal integers from 0 to 60000; without a valid activation query the button stays disabled. After its terminal status, stop watch with Ctrl-C; then stop the fixture in terminal A. For combined execution, `arm` requires both `--at "$AT"` and `--when '#reserve:enabled'`, plus the same launch/URL/approval/selector/action flags, and evaluates them with AND.

While an action owner runs, **terminal C** can query or cancel it:

```sh
flashact status
flashact status JOB_ID
flashact logs
flashact cancel JOB_ID
```

Replace `JOB_ID` with emitted output. Use the same `FLASHACT_HOME` in both terminals if overridden. Cancellation before dispatch is not an undo operation. Generated CLI plans omit a verification selector, so their `VERIFIED` means local synthetic click evidence only. Inspect the fixture ledger/receipt for local behavior; consequential sites need meaningful independent verification.

## CLI command reference

`doctor`, `connect`, `tabs`, `inspect`, `schedule`, `watch`, and `arm` share `--backend <backend>` (default `playwright`), `--tab <id>`, `--url <url>`, `--endpoint <endpoint>`, `--launch`, and `--headless`. Aside rejects launch/headless and requires an explicit existing tab for inspection/execution. For each command, consult its implemented help before use:

| Help invocation | Source-defined syntax and behavior |
| --- | --- |
| `flashact --help` | List actual commands and global options. |
| `flashact --version` | Report package version. |
| `flashact doctor --help` | Reports Node/OS/package/Aside diagnostics; currently probes Aside regardless of selected backend. |
| `flashact connect --help` | Connect, print tabs, and disconnect; not a durable session. |
| `flashact tabs --help` | Connect, enumerate tab IDs, and disconnect. |
| `flashact inspect --help` | Requires `--selector <selector>`; inspect the selected exact tab. |
| `flashact schedule --help` | Requires `--at <time>`, `--approved-url <url>`, `--action click`, and a target selector. Immediately validates/arms; stays foreground. |
| `flashact watch --help` | Requires `--when <condition>`, `--approved-url <url>`, `--action click`, and a target selector. Immediately validates/arms; stays foreground. |
| `flashact arm --help` | Requires both `--at <time>` and `--when <condition>` plus approval/action/selector; combines them with AND. Not a JSON file loader. |
| `flashact status --help` | `status [jobId]`; queries all jobs if omitted. |
| `flashact cancel --help` | `cancel <jobId>`; request cancellation before dispatch. |
| `flashact logs --help` | `logs`; read bounded lifecycle logs. |
| `flashact benchmark --help` | `--iterations <count>` (default 10), `--backend <backend>` (playwright), `--mode <mode>` (browser/node/cdp, default browser), `--output <path>`, `--tab <id>`. |
| `flashact mcp --help` | Stdio server; `--launch`, `--headless`, `--url <url>` or `--endpoint <endpoint>` configure Playwright only. |

Action commands also accept `--selector <selector>`, `--approve-irreversible`, `--timezone <IANA>` (UTC), `--attribute <name>`, `--value <value>`, and `--foreground` (always enabled; there is no daemon mode). Conditions are `enabled`, `appear`, `visible`, `attribute`, or `text`; `#selector:enabled`, `:appear`, and `:visible` shorthand can supply the target selector. Attribute conditions require `--attribute`. `--at` accepts `HH:mm:ss[.SSS]` or an ISO instant with an explicit offset. Scheduled plans expire 60 seconds after the deadline; event-only plans expire 24 hours after construction. Generated plans have random job IDs and no verification selector. The CLI currently exposes no `--plan`, verification-selector, expiry, or watch-root option; use MCP's full-plan input for the JSON examples and meaningful verification.

`connect` and `tabs` do not share a persistent connection with later invocations. Prefer CDP attachment with the stable tab ID returned by `tabs` when using separate commands; launch-local IDs are not reusable across processes. `status`, `cancel`, and `logs` use authenticated localhost control in `src/cli/ipc.ts`.

After approving a harmless local fixture, these source-matched examples show the syntax (replace the endpoint/tab/URL/time):

```sh
flashact tabs --backend playwright --endpoint http://127.0.0.1:9222
flashact inspect --endpoint http://127.0.0.1:9222 --tab APPROVED_TAB_ID --selector '#reserve'
```

Run only one action owner per control home. In a second terminal use `flashact status`, `flashact logs`, or `flashact cancel JOB_ID` with the emitted job ID. Action commands stay alive **even after a terminal result** until SIGINT/SIGTERM; stop them explicitly when finished. These are syntax examples, not commands executed by this documentation task.

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

## Caller-owned host scheduling (opt-in SDK)

The updated local build exposes `await playwrightAdapter.wake(jobId)` after an
approved plan has been installed and armed. It asks the existing browser runtime
to recheck readiness immediately; it does not bypass guards or synthesize a raw
click. Repeated/early/terminal wakes cannot force execution. A host scheduler can
call it at scheduled leaf deadlines while browser timers and observers remain
active. This capability is not automatically enabled by `JobEngine`, CLI or MCP.

Retain the `NodeScheduler` cancellation handle and every resulting wake promise.
Stop future callbacks first; join started RPCs through a caller-owned termination
boundary. A sent evaluation cannot be cancelled by its timer handle. Borrowed
pages do not provide bounded shutdown for a permanently pending SDK evaluation.
Use `adapter.wake` for installation binding; root-exported `wakeExpression` is
only a low-level current-realm expression. See [contracts](CONTRACTS.md).

Native hidden comparison and method are recorded in
[hidden scheduling improvement](docs/hidden-scheduling-improvement.md).

## Aside is a separate integration

The integrated Aside adapter uses official capabilities in separate discovery and attachment steps: `listBrowserTabs()` → approved exact target ID → `attachBrowserTab(targetId)` → `page.evaluate(...)`. Do not copy profiles, guess private CDP endpoints, or replace Aside with Playwright. Keep an ordinary, operator-opened Aside UI tab alive; the adapter attaches rather than owning a new tab. `AsideAdapter` rejects `options.url`, endpoint, launch, and userDataDir because a one-shot `openTab` tab can disappear with its owner. CLI `--url` for Aside is a target URL filter/plan value, not permission to create or navigate a tab; `--tab` is mandatory for inspection/execution.

```sh
flashact tabs --backend aside
flashact inspect --backend aside --tab APPROVED_ASIDE_TAB_ID --selector '#reserve'
flashact watch --backend aside --tab APPROVED_ASIDE_TAB_ID \
  --approved-url 'http://127.0.0.1:3000/local.html?enableAfter=5000' \
  --selector '#reserve' --action click --when '#reserve:enabled'
```

Open that exact harmless URL in Aside yourself first and approve it before arming. It may already be enabled by the time attachment completes. No arbitrary existing tab is mutated by these instructions.

The independently owned [Aside integration report](docs/aside-integration.md) documents a task-local probe: page-side observers/timers survived the installing one-shot CLI call only while another owner kept the attached tab alive; full navigation replaced the runtime. That result does not grant daemon guarantees or permission to mutate other tabs.

## MCP configuration

The required launch target is **`flashact mcp`**, not an invented server executable:

```json
{
  "mcpServers": {
    "flashact": {
      "command": "flashact",
      "args": ["mcp", "--launch", "--headless", "--url", "http://127.0.0.1:3000/local.html?ready=1"]
    }
  }
}
```

Start the local fixture first and ensure the locally installed executable is on the MCP client's PATH. This configuration launches only a task-owned Playwright browser/page; it does not arm a job. For approved Playwright CDP attachment replace the args with `["mcp", "--endpoint", "http://127.0.0.1:9222"]`; do not also pass `--launch` or `--url`. `--url` requires `--launch`, and launch/endpoint are mutually exclusive. For Aside-only use `["mcp"]`, select `backend: "aside"` in tools, and provide an existing approved tab ID in the plan. Playwright options are scoped by backend and do not leak into Aside. Exact ten tools (also enumerated by the coordinator's actual MCP check):

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

The package root exports `JobEngine`, `PlaywrightAdapter`, `AsideAdapter`, `NodeScheduler`, `createAdapter`, `runBenchmark`, and `createMcpServer`, alongside public contracts and schemas. Use `parsePlan` on decoded JSON before API execution. No publishing or commits are part of these reproduction instructions.
