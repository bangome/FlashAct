# FlashAct 0.1.0 shared contracts

Frozen shared contracts used by the integrated runtime, adapters, CLI and MCP.
This document specifies wire types and validation, not a foundation-only project stage.
Use Node 22 LTS (>=22.12.0) and npm. Native ESM is compiled by `tsc`; there is
no bundler. The browser runtime uses self-contained factories serialized with
`toString()` without importing host-side dependencies.

## ExecutionPlan (`src/core/types.ts`)

All fields are readonly. Wire primitives remain plain strings/numbers; consumers
do not need branded-value constructors. `?` means absent or the declared value,
not an explicit `undefined` or `null`. Unknown object keys are rejected.

```ts
type ExecutionPlan = {
  schemaVersion: "1.0";
  jobId: string;
  name: string;
  backend: "playwright" | "aside";
  target: { tabId: string; selector: string; url: string; watchRoot?: string };
  trigger: Trigger;
  action: { type: "click" };
  timezone: string;
  expiresAt: number;
  maxExecutions: 1;
  verification: { selector?: string; timeoutMs: number };
  guards: { approvedUrl: string; allowIrreversible: boolean };
};

type Trigger =
  | { type: "SCHEDULED"; at: number }
  | { type: "ELEMENT_APPEAR" | "ELEMENT_ENABLE" | "ELEMENT_VISIBLE"; selector: string }
  | { type: "ATTRIBUTE_CHANGE"; selector: string; attribute: string; value?: string }
  | { type: "TEXT_CHANGE"; selector: string; value?: string }
  | { type: "AND" | "OR"; conditions: readonly Trigger[] };
```

- Only single-shot execution is supported: `maxExecutions` must equal `1`.
- Trigger depth is at most **8**, counting the root as depth 1. Each composite
  has **1–32** conditions. The schema itself is depth-bounded, including for
  cyclic JavaScript inputs; it is not an unbounded parser with a later check.
  Exported constants: `MAX_TRIGGER_DEPTH`, `MAX_TRIGGER_CONDITIONS`.
- Identifiers, names, selectors, attribute names, and watch roots must contain
  non-whitespace text. Values for text/attribute matching may be empty strings.
  An absent value means observe a change without an exact-value constraint.
- `at` and `expiresAt` are nonnegative integer epoch milliseconds within the
  JavaScript Date range. `timeoutMs` is a positive safe integer duration.
- `timezone` must be accepted by Node's `Intl.DateTimeFormat` (including `UTC`).
  Epoch timestamps are already absolute; timezone never changes their meaning.
- URLs must be absolute URLs. `guards.approvedUrl` must exactly equal
  `target.url`; neither is normalized. Runtime must separately check the live
  URL and irreversible-action permission before dispatch.
- Parsing does not consult the clock or the DOM: expired persisted plans remain
  readable, and selector syntax/existence is inspected by the browser adapter.
  This contract does not prescribe lifecycle transitions or trigger evaluation.

## Status and browser data

Exact `JobState` values (also exported as `JOB_STATES`):

`DRAFT VALIDATED ARMED WAITING DISPATCHED VERIFIED UNKNOWN FAILED EXPIRED CANCELLED INVALIDATED`

```ts
type JobTiming = {
  targetEpochMs?: number;
  schedulerEpochMs?: number;
  receivedEpochMs?: number;
  observerEpochMs?: number;
  clickEpochMs?: number;
  conditionEpochMs?: number;
};
type JobStatus = {
  jobId: string;
  state: JobState;
  executions: number;
  message?: string;
  timing?: JobTiming;
  execution?: ExecutionInfo;
  updatedAt: number;
};
type RuntimeHandle = { jobId: string; documentId: string };
type TargetInfo = {
  selector: string;
  count: number;
  enabled: boolean;
  visible: boolean;
  url: string;
  irreversible: boolean;
};
type BrowserTab = { id: string; url: string; title: string };
```

`executions` is an integer in 0–1; `count` is a nonnegative safe integer.
`updatedAt` is an integer epoch timestamp. Optional timing measurements are
finite nonnegative epoch milliseconds within the Date range, allowing fractions
for browser high-resolution measurements. Empty messages and titles are valid.
Browser tab URLs may include absolute browser URLs such as `about:blank`.

## BrowserAdapter (`src/adapters/browser-adapter.ts`)

Options are provided to concrete adapter constructors, not `connect()`.
All operations are asynchronous; implementors must use these signatures:

```ts
interface BrowserAdapter {
  readonly owner?: AdapterOwner;
  connect(): Promise<void>;
  listTabs(): Promise<readonly BrowserTab[]>;
  selectTab(tabId: string): Promise<void>;
  inspectTarget(selector: string): Promise<TargetInfo>;
  installRuntime(plan: ExecutionPlan): Promise<RuntimeHandle>;
  arm(plan: ExecutionPlan): Promise<void>;
  wake?(jobId: string): Promise<JobStatus>;
  cancel(jobId: string): Promise<void>;
  getStatus(jobId: string): Promise<JobStatus>;
  evaluate(expression: string): Promise<unknown>;
  disconnect(): Promise<void>;
}
type AdapterOptions = {
  endpoint?: string;
  launch?: boolean;
  headless?: boolean;
  url?: string;
  userDataDir?: string;
  tabId?: string;
};
type AsideOptions = { executable?: string; account?: string; host?: string };
```

`AsideAdapterOptions = AdapterOptions & AsideOptions` is exported for convenience.
`selectTab` establishes the tab for later inspection/evaluation. Runtime handles
identify both a job and the installed document; navigation invalidates that
document identity. `arm` and `cancel` acknowledge commands, not verification;
retrieve status with `getStatus`. Both adapters are implemented without profile
copying. Aside integration uses the real `listBrowserTabs`,
`attachBrowserTab`, and `page.evaluate` capabilities, not invented CLI commands.

### Opt-in host wake

The updated local build's `PlaywrightAdapter.wake(jobId)` returns an observation
of one immediate readiness check on an already armed installation. It does not
install, arm, force a trigger, click directly, or promise eventual verification.
An unarmed job is unchanged; a terminal or dispatched job cannot execute again.
The runtime retains its browser clock, URL, cached-target/removal, enabled,
visible, irreversible approval, expiry, and single-shot checks. Browser timers
and reactive observers continue to operate. No plan field changes; CLI/MCP now
default to owned transport and auto scheduling. The interface capability is optional;
Aside does not expose it as an adapter method.

The Playwright control command binds the installation token, runtime object and
document ID and invokes the captured runtime in one synchronous browser task.
Stale command/console snapshots cannot regress a retained execution or terminal
status. Later execution evidence after loss retains `UNKNOWN` and does not make
the installation reusable. There is no reinjection, rearm or automatic retry.

`wakeExpression(jobId)` is also exported from the package root. Its escaped
expression returns JSON `JobStatus` from the current realm. It is a low-level
operation, not an installation-bound substitute for `adapter.wake`.

The caller owns host scheduling and every outstanding wake promise.
`NodeScheduler` is single-shot and its callback does not await async operations.
Cancel all future host callbacks before cancellation/shutdown, then join started
operations through the caller's actual transport/worker ownership boundary.
Cancelling a timer cannot retract a sent RPC; a timeout or racing waiter is not
producer termination. The benchmark's owned SDK worker supplies termination and
join; a direct borrowed SDK page does not imply cancellable `page.evaluate` or
bounded shutdown. Host/browser epoch disagreement can lose acceleration, never
bypass browser readiness. For AND/OR plans schedule distinct leaf deadlines,
not merely the maximum timing field.

### Owned engine and execution provenance

`EngineOptions.adapterMode` is `direct | owned`; `scheduling` is
`browser | auto | host`. SDK defaults remain direct/browser; CLI and stdio MCP
choose owned/auto. Auto uses host assistance only with owned wake-capable
transport and scheduled leaves. Explicit host rejects unsupported transports.
Auto reactive-only plans use browser scheduling. Distinct nested scheduled leaves,
past deadlines and expiry are bounded/deduplicated; the browser remains the
only dispatch authority.

```ts
type ExecutionInfo = {
  requested: "browser" | "auto" | "host";
  scheduler: "browser" | "host-assisted";
  transport: "direct" | "owned-worker" | "owned-aside-cli";
  browserOwnership: "owned" | "borrowed";
  reason: "explicit-browser" | "explicit-host" | "scheduled-leaves"
    | "no-scheduled-leaves" | "unsupported-host-wake" | "cooperative-transport";
};
interface AdapterOwner {
  readonly kind: "launched-browser" | "endpoint-client" | "aside-client";
  subscribe(listener: (status: JobStatus) => void): () => void;
  stop(reason: "shutdown" | "deadline" | "cancel"): Promise<readonly JobStatus[]>;
}
```

Execution provenance is optional, strictly parsed and host-authoritative. It
does not change plan version or timing meanings. `owner.stop` seals admission
synchronously and resolves only after producer exit/join, not a raced timeout.
Playwright startup/RPC/cancel-shutdown deadlines are 30 s/5 s/2 s. Loss poisons
the connection, can affect its other jobs, and never reconnects or retries.
Armed uncertain jobs retain UNKNOWN and their last observed 0/1 count even after
later evidence; UNKNOWN with 0 is not proof of no external effect.

Owned launch uses a fresh private profile and parent-owned Chrome process group
on Darwin/Linux. Endpoint ownership terminates the SDK client only; the browser,
tabs and profile remain borrowed. Owned Aside uses persistent official MCP CLI
sessions: one control session and an independent installation-bound event reader
per pending job. Target inspection stays live and typed without repeated snapshots.
Readers have a 20-second observation lease and a 25-second RPC deadline, below
Aside's measured 30-second inner CDP evaluation limit; initial
acquisition is bounded to 30 seconds and ordinary operations to five seconds.
Loss never reconnects or retries. Owned Aside joins its actual CLI processes.
Close/cancel can preempt a stuck status request, cancel future host callbacks,
join started operations and retain final statuses for post-close reads.

`JobEngine.subscribe(listener)` returns an unsubscribe function. It emits changes
to retained state/count, host execution metadata or timing evidence, omitting page
messages and timestamp-only duplicates. Foreground CLI subscribes before creation
and waits for abort rather than status polling. Explicit status/result queries
still reconcile nonterminal runtime state; terminal retained reads need no browser.

## Validation and errors

### Optional post-click text-image CAPTCHA

An optional `ExecutionPlan.captcha` configures a separate single-use workflow.
The original click remains `maxExecutions: 1`; host-owned `JobStatus.captcha`
records input and explicit optional submission separately, each bounded to one.
Original `VERIFIED` never implies CAPTCHA verification. Submit requires an
explicit selector and a fresh observed success selector. Existing approved URL,
document identity, uniqueness and irreversible-action guards apply to this step.

Default OCR uses a warm local macOS Vision/Swift producer prepared before arm;
the SDK can inject a `CaptchaRecognizer`. Capture/recognition never obtains an
answer from DOM text. Ambiguous/low-confidence output, changed challenge pixels,
nonempty input, cancellation or uncertainty never causes retry or rearm.
Capture and input are bound to the original tab. Main `UNKNOWN` stops the
companion, and a failed input/submission acknowledgement remains CAPTCHA
`UNKNOWN`. Shutdown joins the OCR child and owned observation processes.
See `docs/captcha.md` for configuration, limits and nested outcomes.

`src/core/schema.ts` exports `parsePlan`, `planSchema`, `triggerSchema`,
`jobStatusSchema`, `targetInfoSchema`, `browserTabsSchema`, `runtimeHandleSchema`,
and the two trigger-limit constants. Schema `.parse()` methods take unknown
values and throw Zod errors; `.safeParse()` is available for nonthrowing callers.

`parsePlan(input: unknown): ExecutionPlan` accepts a decoded object, not a JSON
string. Invalid input throws `FlashActError` with code `INVALID_PLAN` and the
original Zod error as `cause`. There is no coercion or automatic defaulting.

`evaluate` intentionally returns `unknown`, never an unchecked generic `T`.
For runtime commands the expression should return a JSON string: adapters first
parse that result with `z.string()`, then `JSON.parse` into an `unknown` variable,
then parse with the appropriate shared result schema. Plain browser results
are likewise parsed at their boundary. No JSON transport envelope is invented.

`src/utils/errors.ts` exports `FlashActError`, `FlashActErrorCode`, and
`assertNever(value: never): never`. The constructor is
`new FlashActError(code, message, options?: ErrorOptions)`. Frozen error codes:
`INVALID_PLAN`, `ADAPTER_ERROR`, `INVALID_RESPONSE`, `GUARD_REJECTED`,
`JOB_NOT_FOUND`, `INVALID_STATE`, `INTERNAL_ERROR`. `assertNever` throws
`INTERNAL_ERROR` if an impossible branch is reached at runtime.

## Package surface and checks

`src/index.ts` re-exports shared types, schemas, adapter contracts and errors,
plus `JobEngine`, concrete adapters, `NodeScheduler`, `createAdapter`,
`runBenchmark` and `createMcpServer`. Package `flashact@0.1.0` exports
`dist/index.js` with declarations at `dist/index.d.ts`. The implemented
`fa` bin is `dist/cli/index.js`; help uses program name `fa`, and current
commands use `fa --<command>`. The npm package name stays `flashact`, and MCP
tool names stay `flashact_*`. `prepack` compiles the CLI before packaging.

- `npm install`: install the pinned dependencies and generate the npm lockfile.
- `npm run build`: compile source with `tsc` (no browser bundle).
- `npm run typecheck`: check source and contract tests without emitting.
- `npm test`: run unit, browser integration and CLI/MCP tests with Vitest.
- `FLASHACT_ASIDE_INTEGRATION=1 npm test`: also run live Aside integration.

The repository also contains the runtime, concrete adapters, CLI, MCP server,
benchmark harness and their real-surface test evidence. See README and docs for
supported behavior and explicit unverified platform/performance conditions.
