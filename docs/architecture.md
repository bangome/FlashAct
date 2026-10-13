# Architecture

## Scope and source of truth

`CONTRACTS.md`, `src/core/types.ts`, and `src/core/schema.ts` define the public wire contract. The integrated MVP has passed strict build/typecheck, real browser integration, local npm tarball installation, and installed CLI/MCP execution. README and `artifacts/qa` record the current suite and manual receipts; these do not imply an execution SLA or verified Windows behavior.

The package root exports `JobEngine`, `PlaywrightAdapter`, `AsideAdapter`, `NodeScheduler`, `createAdapter`, `runBenchmark`, and `createMcpServer`, plus types, schemas, and errors. npm prepack builds the package; shipped docs/examples and the fixture script accompany dist. Fixture loading uses a module-relative `new URL` so unrelated working directories do not determine its asset path.

```text
foreground CLI / MCP owner
    ├── JobEngine: parse → create → validate → arm → status/cancel
    ├── localhost authenticated control: status / cancel / logs
    └── BrowserAdapter
          ├── Playwright: explicit launch or CDP attachment
          └── Aside: official discovery + exact attachment (separate integration)
                ↓ evaluate serialized runtime / JSON commands
          document-local runtime
                ├── DOM inspection and guards
                ├── trigger predicates + observers + timers
                └── one synthetic click → local verification → terminal result
```

## Contract and validation

An `ExecutionPlan` has `schemaVersion`, `jobId`, `name`, `backend`, `target`, `trigger`, `action`, `timezone`, `expiresAt`, `maxExecutions`, `verification`, and `guards`. The only action is `{ "type": "click" }`; `maxExecutions` is literally `1`. Optional fields are absent or correctly typed, never null. Strict Zod objects reject extra keys. `parsePlan` takes a decoded object and wraps validation failure as `FlashActError("INVALID_PLAN", ...)`.

Validation bounds trigger parsing itself to depth 8 and 1–32 composite children. It checks integer epoch timestamps, absolute URLs, a supported timezone, and exact string equality of `target.url` and `guards.approvedUrl`. It does not check current time, selector syntax, DOM presence, or the live document; those checks belong to execution boundaries. Thus a persisted expired plan can be read without becoming executable.

## Host engine and control plane

`src/core/engine.ts` serializes host operations through a promise queue. `createJob` establishes `DRAFT`; `validateJob` checks expiry and live target guards before `VALIDATED`; `armJob` rechecks immediately before installing and arming the runtime. An absent target is allowed only where the engine's appearance-trigger rules permit it. Multiple target matches or an unapproved irreversible action reject validation. Arming acknowledgement is not action verification.

Jobs and lifecycle logs are in-memory. Logs retain at most 1,000 entries; state-transition entries deliberately omit free-form runtime messages that might contain page data. `getStatus` queries installed nonterminal jobs and validates returned statuses and job IDs. `close` attempts to cancel nonterminal installed jobs, then disconnects adapters. An acknowledgement failure after installation triggers a cancellation attempt; it cannot prove no click occurred.

`src/cli/ipc.ts` implements cross-process **control**, not a background service. A foreground owner binds HTTP to `127.0.0.1` on an ephemeral port. It accepts `GET /status` (optional `jobId`), `GET /logs`, and `POST /cancel` (required `jobId`). The metadata file contains a cryptographically random 32-byte bearer token encoded as 64 hex characters; authorization uses constant-time comparison and loopback peer checking. Clients read owner-only metadata, authenticate requests, use a five-second timeout, and cap responses at 1 MiB.

`FLASHACT_HOME` overrides `~/.flashact`. Exclusive creation of `engine.json` prevents two owners claiming the same home. Normal close removes metadata; stale metadata after a crash requires manual reconciliation. POSIX ownership/mode checks and symlink rejection protect metadata; Windows has a PowerShell ACL creation path, **not a tested Windows guarantee**. A local process with the user's privileges can read credentials; this is not a hostile-same-user sandbox.

`src/cli/foreground.ts` creates/validates/arms one generated plan, polls status every 100 ms, and remains alive even after terminal results until SIGINT/SIGTERM. Cleanup closes the engine and control server. `connect`, `tabs`, and `inspect` instead use a short-lived engine and disconnect on completion. Schedule/watch/arm construct plans from flags; they do not load JSON files and currently omit a verification selector. `arm` combines time and event conditions with AND. Stop schedule before watch when sharing a control home.

MCP registers the ten tools listed in README, including full-plan create/validate/arm, and closes on stdio EOF, server close, or signals. `mcp --launch --headless --url <local-url>` configures a task-owned Playwright page; `mcp --endpoint <endpoint>` attaches explicitly instead. URL requires launch; endpoint and launch are mutually exclusive. `EngineOptions.adapterOptionsByBackend` isolates these Playwright options from Aside. Aside-only stdio can start with `mcp` and use tool backend `aside`, with exact existing tab IDs in plans. There is no connect tool. There is no durable job database, automatic restart, service manager, or daemon-lifetime promise. SIGKILL or abrupt termination cannot guarantee cancellation, disconnection, or metadata cleanup. Page work surviving a client is not supported recovery or proof that cancellation succeeded.

## Adapter boundary

The shared `BrowserAdapter` contract provides `connect`, `listTabs`, `selectTab`, `inspectTarget`, `installRuntime`, `arm`, `cancel`, `getStatus`, `evaluate`, and `disconnect`. Constructor options configure connections; `connect()` takes no arguments. Generic evaluation returns `unknown`. Runtime commands return JSON strings that the bridge decodes and validates with shared schemas.

The Playwright adapter supports supplied page/context objects, an explicit CDP endpoint, or explicit `launch: true`. A supplied URL opens a **new** page rather than navigating an existing selected page. CDP tabs use public target IDs; locally launched pages receive adapter-local UUIDs, so do not assume IDs survive a new process. Borrowed pages/contexts are not closed as owned resources. Disconnect attempts runtime cancellation; launched resources are closed, whereas attached CDP connections are disconnected.

`RuntimeJobs` records runtime handles, tab IDs, document markers, and armed state. Main-frame navigation, tab closure, or marker replacement invalidates pending jobs. A transport-only disconnect can leave the browser document executing: an unconfirmed armed outcome must be `UNKNOWN`, even if the client previously observed console events. Definitive runtime cancellation or completion can be retained, and known unarmed failure can be `FAILED`/`INVALIDATED`. Aside has no continuous dispatch observation, so armed document loss is also `UNKNOWN`. An unknown zero count is only the last observed count, never proof of no click; never replay the action automatically.

The integrated Aside adapter uses actual `listBrowserTabs`, then `attachBrowserTab` for the independently approved target ID, then public `page.evaluate`, with official snapshots for inspection. It is not an undocumented CDP connection or a copied user profile. It rejects constructor `options.url`, endpoint, launch, and userDataDir; keep an ordinary Aside UI tab open and supply its exact ID. CLI URL is a target filter/value, not a new-tab ownership mechanism. See the independently authored [Aside integration report](aside-integration.md) and [real adapter QA](../artifacts/qa/aside-adapter.json) for measured lifetime evidence and explicit limits.

## Document-local execution

`src/runtime/index.ts` assembles self-contained serialized factories; host imports are not browser dependencies. Bootstrap owns `globalThis.__flashactRuntime`, a document ID, and a registry of jobs. It clones plans and rejects reuse of a job ID with a different canonical plan. Navigation/pagehide/unload and detected URL changes invalidate the original document's jobs; a stable tab ID is not a stable document ID.

Trigger predicates compile **at arm**. `ELEMENT_APPEAR` is existence, `ELEMENT_ENABLE` is enabled state, and `ELEMENT_VISIBLE` is the runtime's visibility predicate. Explicit attribute/text values match current state, even if already satisfied at arm; absent values compare against the arm-time baseline. `AND` evaluates all predicates currently true and does not latch a past enabled/visible state. `OR` needs any current predicate. Scheduled conditions require both wall time and page-derived epoch time to reach the supplied instant.

Mutation observers and a resize observer wake checks, with bounded timer rechecks (currently up to 25 ms) for deadlines, expiry, and conditions. Optional `watchRoot` must be unique, connected, and contain the action target. The action element is cached; removal or selector mismatch fails rather than silently retargeting to a replacement. Dispatch rechecks uniqueness, enabled/visible state, URL/document identity, expiry, and irreversible permission.

The runtime claims `executions: 1` **before** invoking `HTMLElement.prototype.click.call(element)`, protecting against reentrant duplicate dispatch. It records local click timing and optionally watches for the verification selector. Selector presence can produce `VERIFIED`; timeout or click-handler uncertainty produces `UNKNOWN`, with no repeat. Without a verification selector, a captured synthetic click can still produce `VERIFIED`, but that status certifies only local dispatch, **not site/network success**. A verification element already present can also satisfy verification; choose evidence that distinguishes this action from stale state.

The exact state vocabulary is:

```text
DRAFT VALIDATED ARMED WAITING DISPATCHED
VERIFIED UNKNOWN FAILED EXPIRED CANCELLED INVALIDATED
```

The latter six are terminal at the host level. Do not assume every transition is externally observable or strictly linear: a ready trigger may dispatch during arm, and host `ARMED` acknowledgement precedes its next runtime-status reconciliation. Cancellation before dispatch stops waiting work; it cannot undo a click already claimed/dispatched. Runtime document invalidation and host transport-loss handling may report different terminal states depending on what was last observed.

## Timing and evidence

`NodeScheduler` is an independent host scheduler interface, not the owner of browser trigger dispatch. It chunks long delays to the platform timer limit and rechecks wall time after waking. Browser timing fields include target, scheduler, received, observer, condition, and click epoch measurements; browser high-resolution timestamps may be fractional. Process-local monotonic clocks are not comparable across processes without calibration.

The [benchmark report](benchmark-results.md) distinguishes runtime, NodeScheduler/page-evaluate, and public Playwright CDP baselines. No public Aside CDP endpoint was established. The raw `node-timer.json` is separate `setTimeout` evidence, not NodeScheduler performance. Short 12 ms scheduled deadlines in one official Aside REPL session yielded scheduled p99 2.4 ms and reactive p99 0.5 ms over 1,000 trials. The [initial multi-command timings](../artifacts/qa/aside-initial-timing.json) recorded an 8-second scheduled click 365.7 ms late and AND 285.2 ms late (reactive 0.9 ms, OR 0.5 ms); subsequent integration runs have their own recorded samples. These different session/horizon measurements must not be merged or used as an SLA. Aside CPU contention p99 was 53.4 ms over 20 trials, missing a 50 ms goal.

The independently owned hidden-tab artifact is `not-verified`, with native visibility still visible, a timeout, and zero trial batches; teardown closed its owned context/browser/server. Neither that attempt nor ordinary visible-tab benchmarks establishes hidden-tab throttling behavior. Windows, sleep/wake, long-horizon precision, real-site success, and daemon durability are not established.
