# Aside read and confirmation path

Owned CLI/MCP connections reuse one official `aside mcp` control process. Initial
tab discovery/attachment uses snapshots; subsequent inspection reads the live
typed URL, selector count, visibility, enabled state and irreversible classification.
It caches the selected binding, not target readiness or completion evidence.
Direct SDK `AsideAdapter` retains its cooperative one-shot command runner.

Each pending owned job has an independent official MCP read session because Aside
serializes REPL calls. The installed document emits status changes. A reader first
registers a listener, then checks current installation/token/document identity and
observed evidence, avoiding a subscribe/read race. A 20-second observation lease
renews the read without rearming or recreating the job; its RPC deadline is 25 seconds.
This stays below the measured 30-second inner `Runtime.evaluate` deadline, even
though the outer REPL supports 120 seconds. The earlier 85-second lease could
turn an unchanged WAITING job into UNKNOWN when that inner deadline expired.
Ordinary operations have a five-second deadline and acquisition has 30 seconds.

The engine projects validated state/count, host-owned execution provenance and
timing changes. Foreground subscribes before job creation and waits for abort,
not a 100-ms status polling loop. Explicit status/result calls remain available.
Listeners are removed when a document read settles. Stop joins actual owned MCP
processes; borrowed Aside tabs/browser survive. After connection loss a remote
read-only listener can remain until its lease expires. This does not prove that
an armed action was cancelled: UNKNOWN remains terminal with the last observed
count and no automatic retry, reconnect or rearm.

`status.execution.reason: "unsupported-host-wake"` with `scheduler: "browser"`
is the expected automatic policy for Aside, not a runtime failure or a retry
request. Browser timers and DOM observers perform readiness checks.

## October 13, 2026 acceptance

Darwin arm64, Node 22, real Aside MCP and authored localhost application:

| Measurement | Cooperative cold path | Owned persistent path |
| --- | ---: | ---: |
| Paired select/inspect samples | 15 | 15 |
| Mean | 905.54 ms | 13.69 ms |
| Median | 903.13 ms | 13.75 ms |
| p95 | 957.99 ms | 14.53 ms |

Both paths returned identical target fields for every pair. A later real
disabled-to-enabled mutation was reflected immediately in owned inspection:
these timings did not come from caching target results. The comparison includes
each path's selection plus inspection and excludes their initial connections.

The foreground watch and scheduled jobs each produced one accepted HTTP receipt
and VERIFIED with count 1, without an early or duplicate request. Receipt-to-CLI
confirmation was 19 ms and 26 ms; condition/deadline-to-click latency was 0.60 ms
and 3.70 ms. Cancellation produced CANCELLED with count 0, zero observed clicks
and zero HTTP receipts even after enabling the target.

Task-created tabs were closed through their actual owner, MCP/CLI producers
joined, and the HTTP server closed. Existing user tabs were not used as fixtures.
Evidence: `.omo/evidence/read-opt-ce8f5095-b1da-4427-befd-fa034b17dbea.json`
and its paired screenshot. These are local fixture measurements, not a universal
site, background-tab, machine-sleep or latency guarantee.
