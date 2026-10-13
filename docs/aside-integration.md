# Aside browser runtime lifecycle: experimental evidence

Run date: 2026-10-12. Scope: installed official Aside CLI against a task-owned localhost fixture. This is evidence collection, not a shared adapter contract or production automation implementation.

## Answers to the six questions

| Question | Result | Evidence |
| --- | --- | --- |
| How is a tab referenced? | `listBrowserTabs()` returns `targetId`; a separate one-shot `attachBrowserTab(exactTargetId)` resolves it. The same owned ID survived repeated calls, reload, and same-origin navigation. Snapshot refs are different: ephemeral locator handles invalidated by each snapshot. | 06, 07, 10, 13, 16 |
| Does page-side JavaScript persist? | **Yes, while the document and tab remain alive.** `window.probeRuntime` installed by one attached CLI call was present in later attached calls. **A tab opened by a one-shot REPL did not survive that owning session's exit.** | 02–04, 08–11 |
| Does a watcher survive REPL command exit? | **Yes, for an attached tab kept alive by another owner.** The observer installed in call 08 recorded an attribute mutation made in call 09, after 08 exited. Not verified after terminating the owning interactive session. | 08, 09 |
| Can a scheduled DOM click run after command exit? | **Yes under that same ownership condition.** A 15,000 ms `setTimeout` recorded a timer event and clicked `#reserve` after the installing CLI exited. One fixture click appeared in the ledger and snapshot. Actual timer latency was approximately 15,399.6 ms: **not a precision guarantee**. | 08, 11 |
| What happens on reload/navigation? | Reload and full same-origin navigation replaced the document and removed runtime/observer/timer globals. The tab ID remained unchanged. A pending timer installed before navigation produced no click in the new document after its deadline. | 12–17 |
| Is there a documented public direct-CDP path? | **NOT VERIFIED / not documented in the installed guides/help inspected.** No direct endpoint, `connectOverCDP` recipe, debugging-port flag, or public CDP session API was exposed there. Do not infer a private endpoint or equate a Playwright-like API with public CDP access. | official-guides.txt |

## Official API evidence and version scope

Commands executed before browser probes:

```sh
aside guide
aside guide repl
aside --help
aside repl --help
aside guide --help
aside mcp --help
aside skills list
aside skills show aside
```

`artifacts/aside-probe/official-guides.txt` preserves the guides, help, and Aside skill output (the skills-list output was observed in the tool transcript). Installed version: **1.26.1008.1938**, skill version **3**. The CLI advertised **1.26.1010.1739**. No update or installation was performed. The initial guide capture attempt exceeded a 1,000 ms shell timeout; the capture was rerun successfully before starting the fixture.

The installed guide explicitly describes:

- A persistent sandboxed REPL with a 120-second timeout, `page`, `tabs`, and cross-call bindings.
- `listBrowserTabs()` without attachment; `attachBrowserTab(targetId)` to attach and set `page`; `getTabByTargetId(targetId)` for an already attached page.
- `openTab(url)` and `closeTab(tab)` as the required tab-management APIs. It prohibits `page.context().newPage()` and `page.close()` because they leak memory.
- `snapshot(page, options?)` as the primary page-reading API; new snapshots invalidate old refs; action outcomes require a fresh snapshot.
- A temporary one-shot CLI REPL session that is closed after the command (stated in the download section). It does **not** explicitly promise that newly opened tabs outlive that session.
- Remote control using `--host`, not a documented direct CDP endpoint. MCP help lists `exec` and `repl`, not CDP tools.

The shorter `repl --help` still suggests `getTabs()`, whereas the detailed guide documents `listBrowserTabs()`. Experiments used the latter, successfully. No runtime/private endpoint inspection was used.

Public page-reported user agent (07):

```text
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36
```

This establishes the advertised Chrome major version, not an independently verified engine patch version or Aside application version. No private browser-version API was queried.

## Isolation and resource ownership

The fixture is `scripts/aside-probe.mjs`: Node HTTP server, `listen(0, '127.0.0.1')`, no cookies, external requests, browser storage, or dependencies. Both `/` and `/next` serve a fresh document containing `#reserve`, a click counter, and a navigation link. The fixture click listener records `performance.now()` and `Date.now()`.

Startup command:

```sh
nohup node scripts/aside-probe.mjs > artifacts/aside-probe/server.log 2>&1 < /dev/null & disown
```

Actual ready receipt:

```json
{"event":"ready","pid":20080,"host":"127.0.0.1","port":55236,"url":"http://127.0.0.1:55236/","wallMs":1791789924844}
```

The baseline listing reported 11 tabs. No user titles, URLs, DOM, screenshots, settings, sessions, credentials, or memories were printed or inspected. Listings were reduced to a count or the exact task-local URL/target ID. Only task-owned tabs were opened, attached, mutated, reloaded, navigated, and closed. `openTab` itself may change browser focus; the experiment did not explicitly manipulate user-tab activation or verify restoration of focus.

First one-shot open: successful snapshot with `Clicks: 0` (02), followed by an empty exact-URL match (03) and 11 tabs / no local fixture match (04). Consequently the later experiment kept an interactive CLI alive as the tab owner, rather than assuming one-shot ownership persists.

Exact owner launch (account/session banners in its saved output were redacted):

```sh
nohup node --input-type=module -e 'import {spawn} from "node:child_process"; const child=spawn("aside",["repl"],{stdio:["pipe","inherit","inherit"]}); console.log("PROBE_OWNER "+JSON.stringify({event:"started",pid:process.pid,asidePid:child.pid,wallMs:Date.now()})); child.stdin.write("await openTab(\"http://127.0.0.1:55236/\"); console.log(\"PROBE_JSON \" + JSON.stringify({stage:\"owner-open-snapshot\",wallMs:Date.now(),snapshot:await snapshot(page,{interactive:true})}));\n"); process.once("SIGTERM",()=>{console.log("PROBE_OWNER "+JSON.stringify({event:"stdin-end",wallMs:Date.now()})); child.stdin.end();}); child.once("exit",(code,signal)=>console.log("PROBE_OWNER "+JSON.stringify({event:"exited",code,signal,wallMs:Date.now()})));' > artifacts/aside-probe/05-owner.txt 2>&1 < /dev/null & disown
```

Owner wrapper PID **21790**, Aside CLI child PID **21804**. Target ID: **02988299E05382698F0FE50C74537A04**. Its listed `active` value was `false`; active-tab assumptions were not used.

## Commands and experiment results

One-shot commands used `aside repl "<JavaScript>" 2>&1 | tee artifacts/aside-probe/<file>.txt`. Tagged output used `console.log('PROBE_JSON ' + JSON.stringify(...))`; no internal protocol parsing. Each attach/action command took a snapshot before page reads and a new snapshot after actions. Closing is the exception: no page remains to snapshot; the official `closeTab` receipt is the evidence.

### Tab discovery and exact attachment (06, 07, 10, 13, 16)

Discovery and attachment were **separate CLI invocations**, not a combined discover-and-attach heuristic:

```sh
aside repl "const listedOwned = (await listBrowserTabs()).filter(t => t.url === 'http://127.0.0.1:55236/'); console.log('PROBE_JSON ' + JSON.stringify({stage:'owner-target-list',wallMs:Date.now(),matches:listedOwned.map(t=>({targetId:t.targetId,url:t.url,title:t.title,active:t.active}))}));"
aside repl "await attachBrowserTab('02988299E05382698F0FE50C74537A04'); console.log('PROBE_JSON ' + JSON.stringify({stage:'exact-attach-before-read',wallMs:Date.now(),snapshot:await snapshot(page,{interactive:true})})); console.log('PROBE_JSON ' + JSON.stringify({stage:'fixture-public-version',data:await page.evaluate(()=>({userAgent:navigator.userAgent,boot:window.fixtureBoot,clicks:window.fixtureClicks}))}));"
```

Repeated listing results:

| Stage | Wall milliseconds | Target ID | URL path |
| --- | ---: | --- | --- |
| owner-target-list | 1791789995749 | 02988299E05382698F0FE50C74537A04 | `/` |
| repeat-target-list | 1791790029116 | same | `/` |
| reload-target-list | 1791790052596 | same | `/` |
| navigation-target-list | 1791790077290 | same | `/next` |

These are empirical within-run observations, not a guarantee across closure, reopening, browser restart, remote reconnect, or cross-origin navigation.

### Page runtime, observer, and scheduled DOM click (08–11)

Installing call 08 used this exact evaluated body between before/after snapshots:

```js
await attachBrowserTab('02988299E05382698F0FE50C74537A04');
await snapshot(page, {interactive:true}); // printed in tagged install-before
await page.evaluate(() => {
  const reserve = document.querySelector('#reserve');
  window.probeRuntime = {token:'owned-runtime-1', installedNowMs:performance.now(), installedWallMs:Date.now(), delayMs:15000};
  window.probeObserver = new MutationObserver(records => {
    window.fixtureLedger.push({event:'observer', nowMs:performance.now(), wallMs:Date.now(), records:records.map(r => ({type:r.type, attributeName:r.attributeName})), state:reserve.getAttribute('data-state')});
  });
  window.probeObserver.observe(reserve, {attributes:true, attributeFilter:['data-state']});
  window.probeTimer = setTimeout(() => {
    window.fixtureLedger.push({event:'timer-fired', nowMs:performance.now(), wallMs:Date.now()});
    reserve.click();
  }, 15000);
  return window.probeRuntime;
}); // returned data printed in tagged install
await snapshot(page, {interactive:true}); // tagged install-after: No changes detected
```

After `aside repl` returned, a **local** `node -e 'console.log("PROBE_JSON "+JSON.stringify({stage:"install-cli-exited",wallMs:Date.now()}))'` recorded the installing CLI's post-exit wall time. A later separate attached call took a snapshot, ran `document.querySelector('#reserve').setAttribute('data-state','changed-in-new-call')`, snapshotted again, then read `window.probeRuntime` and `window.fixtureLedger` using `page.evaluate`. A further separate call read the scheduled ledger after taking a new snapshot. No guessed DOM selector or arbitrary user-page JavaScript was used: `#reserve` belongs to the authored fixture.

Actual timing/data (raw JSON in 08, 09, 11):

| Event | `performance.now()` ms | `Date.now()` ms |
| --- | ---: | ---: |
| runtime installed | 30245.19999998808 | 1791790016148 |
| installing CLI exited (local receipt) | n/a | 1791790016208 |
| separate-call mutation | 38108.59999999404 | 1791790024012 |
| observer callback | 38108.79999998212 | 1791790024012 |
| mutation CLI exited (local receipt) | n/a | 1791790024069 |
| timer fired | 45644.79999998212 | 1791790031548 |
| fixture DOM click handler | 45645.19999998808 | 1791790031548 |
| later ledger read | 49077.79999998212 | 1791790034981 |

Observer payload: `records:[{"type":"attributes","attributeName":"data-state"}]`, state `changed-in-new-call`. Observer latency relative to the returned mutation timestamp was approximately **0.2 ms**. The mutation occurred **7,804 ms after the install CLI's exit**. Timer firing occurred **15,340 ms after that exit** and **15,399.6 ms after installation** (about **399.6 ms late**). The click handler followed the timer event by approximately **0.4 ms**. The final snapshot showed `Clicks: 1`; the ledger recorded count `1`.

This is a programmatic `HTMLElement.click()`, **not** a trusted physical-input event, reservation on a real site, execution-time SLA, or evidence about background-throttling policy. Timing is a single observation. Fresh-session snapshot diffs may show the entire tree; within-call post-action diffs were also printed. A `data-state` attribute mutation has no accessibility-tree effect, so its snapshot reported no changes; the observer ledger is the concrete behavioral evidence.

### Reload and navigation lifecycle (12–17)

Reload command core: exact attach → printed snapshot → `await page.reload()` → printed new snapshot → evaluated boot, three `typeof` presence checks, ledger, count, and wall time.

Reload output: `Clicks: 1` became `Clicks: 0`; time origin changed from **1791789985902.3** to **1791790047637.7**. `runtimePresent`, `observerPresent`, and `timerPresent` were all `false`; ledger `[]`. The previously fired timer was already complete; this reload experiment proves runtime replacement, not cancellation of a pending reload timer.

For navigation, call 14 reinstalled `owned-runtime-2`, a `MutationObserver` on `#reserve`, and `setTimeout(()=>document.querySelector('#reserve').click(),15000)`. Actual install: `installedNowMs:14776`, `installedWallMs:1791790062414`; CLI exited at **1791790062474**.

Call 15: exact attach → fresh printed snapshot → `await page.locator('e2').click()` → printed snapshot → runtime read. The ref was obtained from that call's snapshot. New URL: `http://127.0.0.1:55236/next`. New time origin: **1791790069695.7**; runtime/observer/timer presence all `false`, clicks `0`, ledger `[]`, read at **1791790069999**. The accessibility diff said `No changes detected` because the document's accessible content was identical; the snapshot URL, new time origin, and runtime absence prove navigation.

The old nominal timer deadline was **1791790077414**. Call 17 read at **1791790084181**, **6,767 ms after that deadline**: `runtimePresent:false`, `clicks:0`, ledger `[]`, snapshot `Clicks: 0`. This proves no old callback clicked the new document. It does not rule out retaining the old document in a browser history cache; back navigation was not tested.

## Teardown receipts and honest failures

Only the exact owned target was attached and closed:

```sh
aside repl "await attachBrowserTab('02988299E05382698F0FE50C74537A04'); console.log('PROBE_JSON '+JSON.stringify({stage:'close-before',snapshot:await snapshot(page,{interactive:true})})); await closeTab(page); console.log('PROBE_JSON '+JSON.stringify({stage:'close-receipt',targetId:'02988299E05382698F0FE50C74537A04',wallMs:Date.now(),closeTabResolved:true}));"
kill -TERM 21790
kill -TERM 20080
```

- 18: official output `last tab closed. page is now null` and `no current open tabs in this session`; tagged `closeTabResolved:true` at **1791790103305**. These refer to the attaching REPL's tabs, **not** all user tabs.
- 05: owner stdin ended at **1791790103323**; Aside child exited **code 0**, signal `null`, at **1791790103333**.
- server.log: graceful listener-close callback recorded `{"event":"closed","pid":20080,"wallMs":1791790130205}`. Closure took approximately **26.85 seconds** after shutdown signals; the first process-status check still showed the server alive. Do not treat sending SIGTERM alone as a teardown receipt.
- 19: a bounded fallback attempt `kill -INT 20080` failed with **no such process**, because graceful closure had already finished; the second/final `ps -p 20080,21790,21804 -o pid,ppid,state,command` had only the header and no process rows. No SIGINT was delivered. No further status polling was performed.
- The initial one-shot-owned tab disappeared automatically with its owner. Explicit final closure used **`closeTab` only**; no user tab was closed and no profile was copied. No AI `aside exec`, Playwright substitute, package install/update, publish, or commit occurred.

Raw receipts are in `artifacts/aside-probe/01-*.txt` through `19-*.txt`, plus `official-guides.txt` and `server.log`. Only the interactive owner banner's account/session-directory fields were redacted; experiment JSON and timing values were retained. The stdout-parsing artifact records computed timing from tagged JSON rather than Aside's internal transport.

## Integration implications and limits

Use public target IDs for browser-tab attachment; take fresh snapshot refs for each DOM action. Separate page-runtime lifetime from CLI-session lifetime and from owning-tab lifetime. An attached one-shot command can install page-side work that survives its exit, but `openTab` in a one-shot command is not a durable ownership strategy in this tested version. Reinstall document-scoped watchers after reload/full navigation. Do not promise exact deadline execution from a browser timeout. Direct CDP support requires additional explicit public documentation; none was established here.

Not verified: persistent tab ownership after owner exit, restart/reconnect IDs, cross-origin navigation, SPA navigation, trusted input, back-forward-cache restoration, pending-timer cancellation specifically on reload, browser suspension/resume, precision under load, or CDP endpoint availability outside the inspected installed documentation. No dedicated docs connector was available; the requested Markdown file is the deliverable.

## Verification

`node --check scripts/aside-probe.mjs` passed. The actual fixture was exercised through Aside, not just checked syntactically. No application build exists for this standalone evidence task. `lsp_diagnostics` was attempted for the `.mjs` file but reported that the TypeScript language server is not installed and installation had previously been declined; **LSP cleanliness is NOT VERIFIED**, and no installation was attempted.

Tagged stdout was parsed with native `JSON.parse`, rejecting missing ledger events or an incorrect click count. Exact command, following the syntax check:

```sh
node --input-type=module -e 'let input=""; for await (const chunk of process.stdin) input+=chunk; const rows=input.split("\n").filter(line=>line.includes("PROBE_JSON ")).map(line=>JSON.parse(line.slice(line.indexOf("PROBE_JSON ")+11))); const ledgerRow=rows.find(row=>row.stage==="scheduled-ledger"); if(!ledgerRow) throw new Error("Missing tagged ledger"); const {runtime,ledger,clicks}=ledgerRow.data; const fired=ledger.find(event=>event.event==="timer-fired"); const clicked=ledger.find(event=>event.event==="fixture-click"); const observed=ledger.find(event=>event.event==="observer"); if(!fired||!clicked||!observed||clicks!==1) throw new Error("Lifecycle evidence incomplete"); console.log("PROBE_PARSE "+JSON.stringify({source:"11-scheduled.txt",taggedRows:rows.length,token:runtime.token,observerWallMs:observed.wallMs,timerElapsedMs:fired.nowMs-runtime.installedNowMs,timerLatenessMs:fired.nowMs-runtime.installedNowMs-runtime.delayMs,clickAfterTimerMs:clicked.nowMs-fired.nowMs,timerAfterInstallCliExitMs:fired.wallMs-1791790016208,clicks}));' < artifacts/aside-probe/11-scheduled.txt | tee artifacts/aside-probe/20-stdout-parsing.txt
```

Actual parsed result:

```json
{"source":"11-scheduled.txt","taggedRows":2,"token":"owned-runtime-1","observerWallMs":1791790024012,"timerElapsedMs":15399.59999999404,"timerLatenessMs":399.59999999403954,"clickAfterTimerMs":0.4000000059604645,"timerAfterInstallCliExitMs":15340,"clicks":1}
```

Architectural check: the under-50-line fixture owns only the local lifecycle test surface; it introduces no shared contracts or production dependency. Known selectors are authored in the fixture, no untrusted request body enters domain logic, no tagged domain union is introduced, and no helper abstraction or logging framework is added. The real-surface snapshots and ledgers are the behavior evidence; prose is not asserted by tests.
