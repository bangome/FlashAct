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
and reactive observers continue to operate. No new plan field or default
engine/CLI/MCP scheduler is introduced. The interface capability is optional;
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
join; a borrowed production page does not imply cancellable `page.evaluate` or
bounded shutdown. Host/browser epoch disagreement can lose acceleration, never
bypass browser readiness. For AND/OR plans schedule distinct leaf deadlines,
not merely the maximum timing field.

## Validation and errors

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
`flashact` bin is `dist/cli/index.js`; `prepack` compiles it before packaging.

- `npm install`: install the pinned dependencies and generate the npm lockfile.
- `npm run build`: compile source with `tsc` (no browser bundle).
- `npm run typecheck`: check source and contract tests without emitting.
- `npm test`: run unit, browser integration and CLI/MCP tests with Vitest.
- `FLASHACT_ASIDE_INTEGRATION=1 npm test`: also run live Aside integration.

The repository also contains the runtime, concrete adapters, CLI, MCP server,
benchmark harness and their real-surface test evidence. See README and docs for
supported behavior and explicit unverified platform/performance conditions.
