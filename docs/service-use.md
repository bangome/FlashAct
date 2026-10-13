# Local service use

CLI and MCP now use owned transports and auto scheduling. Playwright scheduled
plans receive host readiness checks; reactive plans and Aside use browser
scheduling. SDK defaults remain direct/browser for compatibility.

## First use

Use Node 22.12 through 22.x, install dependencies, build, and install Playwright
Chromium as described in README. Start `node scripts/serve-fixture.mjs 3000`.
Then run:

```sh
URL='http://127.0.0.1:3000/local.html?ready=1'
AT="$(node -e 'process.stdout.write(new Date(Date.now()+15000).toISOString())')"
node dist/cli/index.js schedule --launch --headless \
  --url "$URL" --approved-url "$URL" --selector '#reserve' \
  --action click --at "$AT" --scheduling auto
```

This fixture example verifies local synthetic dispatch only. For an application
with a distinct new completion element, add `--verify-selector <css>` and
`--verify-timeout-ms 5000`. A pre-existing selector can falsely satisfy
verification; check the authoritative application receipt separately.

Keep the process alive through verification. Ctrl-C joins owned work, closes a
launched browser and removes control metadata. Endpoint attachment never closes
the borrowed browser/tab/profile. Action commands remain foreground after
terminal results; `flashact status`, `cancel JOB_ID`, and `logs` use the same
private control home. MCP is `flashact mcp`; EOF and signals trigger cleanup,
with protocol-only stdout and final shutdown status on stderr.

## Policy and recovery

`auto` selects host assistance only for owned wake-capable scheduled plans.
`browser` disables assistance without changing ownership. `host` rejects
unsupported transport/backend choices instead of silently downgrading. Read
`status.execution` for the actual policy/source and `flashact_list_backends`
for side-effect-free discovery.

Cancellation before dispatch stops waiting, not completed effects. Expiry and
URL/uniqueness/irreversible guards remain browser-authoritative. A stuck RPC
terminates its owned client; other jobs on that connection may also become
uncertain. UNKNOWN is terminal, retains the observed count and never retries,
reconnects or rearms. Count 0 is not evidence that no request reached the server.
Reconcile actual application effects manually before any new action.

Abrupt process kill, machine sleep, untested platforms and arbitrary sites have
no cleanup or latency guarantee. Owned launch currently requires Darwin/Linux;
live Aside was not rerun for this service change.

## Current acceptance evidence

October 13, 2026, authored localhost HTTP receipt checks:

| Population | Count | Mean late | Maximum late |
| --- | ---: | ---: | ---: |
| Actual CLI, native minimized/hidden | 20 | 4.81 ms | 6.90 ms |
| Actual stdio MCP, native minimized/hidden | 20 | 6.05 ms | 8.20 ms |

Every sample is included with five-second scheduling lead. Each had one
independent accepted HTTP request, no early or duplicate effect, and VERIFIED
count 1. Separate MCP cases checked current-state AND, earlier-leaf OR and
reactive enable. These populations are not interchangeable with historical
short-horizon SDK/Aside benchmarks or an SLA.

Local `.omo/evidence/service-use-20261013` contains exact plans, argv, all
receipts/protocol messages, native visibility/bounds, screenshots and PTY.
Lifecycle evidence covers cancel, expiry, malformed/guard rejection, repeated
arm and early/reentrant/terminal wake, deliberately withheld actual replies,
UNKNOWN count 0/1, pending-request
SIGINT/EOF, and launched-owner termination with borrowed browser survival.

Fresh tarball installation used a private npm cache/prefix and unrelated working
directory. Actual installed bin and stdio MCP verified independent HTTP effects;
MCP cancellation produced no effect and EOF removed control metadata. Observed
Worker URLs resolved inside the installed package, not this repository. Candidate
tarballs, hashes and literal pack/install/bin commands are retained with reports;
the original tarball was preserved and no registry publication occurred.

The QA entry point is `node scripts/service-use-qa.mjs --scenario <scenario>`,
where scenarios are `cli-hidden`, `mcp-hidden`, `lifecycle`, and `packaged`.
Hidden populations default to 20. QA needs this workstation's owned headed
browser tooling and standalone Bun for its transparent proxy; that requirement
does not apply to installed FlashAct use.
