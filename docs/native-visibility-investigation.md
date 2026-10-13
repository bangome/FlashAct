# Native visibility investigation

On 2026-10-13, between 01:38 and 01:49 UTC, four fresh owned Chrome executions
passed the real native visibility gate. Each observed minimized CDP bounds,
`document.hidden=true`, and a trusted visible-hidden-visible event sequence,
then restored the original bounds and completed cleanup with preserved inputs.
There were zero latency trials.

This disproves a permanent inability to minimize this installed binary with
these flags. It does **not** establish the exact cause of the earlier failures,
prove that they were fixed, or guarantee future minimization.

## What was varied

`scripts/native-visibility-investigation.mjs` wraps the already approved
coordinator/SDK driver without changing them. It binds the fresh loopback
listener to its exact PID and UUID profile before requesting macOS window
listings from Orca. Only windows of that PID are requested; no native input,
user-app enumeration, profile reuse, screenshot, visibility override or stealth
is used.

| Observation mode | macOS reads near minimize | Wrapper evidence | Raw probe |
| --- | --- | --- | --- |
| Before and after each window command | before and after | `native-visibility-51f37a3d-4a15-407a-a566-3812a2035154.json` | `controlled-hidden-probe-333912ce-fd0c-499b-801b-8523b13b14ee.json` |
| `--post-only` | after only | `native-visibility-e66d8ff9-b02e-4819-b28c-e283ab4a1685.json` | `controlled-hidden-probe-934b2dca-a948-4c0a-be22-173f37f9041f.json` |
| `--final-only` | none; read after restored geometry only | `native-visibility-09462529-e281-42d6-8c89-52fcc43de5bf.json` | `controlled-hidden-probe-bca067ff-3b9b-469a-a4e4-3e6003200477.json` |
| Final wrapper validation, `--final-only` | none; read after restored geometry only | `native-visibility-18e2febd-0d67-4bc1-8277-4f229269c87e.json` | `controlled-hidden-probe-dfb0ddc4-e172-462d-b553-36f5afb0971b.json` |

Wrapper files are under `artifacts/qa/`; raw probes are under
`artifacts/benchmark/`. Every row has `HIDDEN_GATE_VERIFIED`, no probe/native
errors, one minimize attempt, successful restoration, `cleanupSuccess=true`,
and matching before/after protected input hashes.

The first read after minimize caught animation geometry, not a settled
minimized window. A later listing contained no on-screen window; restoration
then exposed intermediate animation geometry before the final correct bounds.
An empty window listing alone is **not** a minimization receipt. The gate is
established by the CDP minimized state plus actual trusted document transitions.
These are macOS provider window listings, not a separately recorded direct
NSWindow `isMiniaturized` notification. The early reports' method text called
them AX observations; the final wrapper uses the more precise window-list label.

The post-only success refutes the initial idea that the extra pre-command
native read was necessary. The two final-only successes show that native reads
inside the minimize/visibility interval were also unnecessary in these runs.
All modes retain an extra listener/PID binding before attach; launch timing,
OS/Dock state and unobserved native activation were not otherwise controlled.

## Source-confirmed mechanism, not historical attribution

The installed browser reports Chrome/156.0.8078.4 and revision
`f842f52ef39fd97b449eb27cff414bf05a98ddce`. Source from that exact revision shows:

- `BrowserHandler::SetWindowBounds` calls `window->Minimize()` and returns
  success without waiting for a minimized-state completion receipt.
- The Cocoa window's minimization begins a nonblocking round trip with the Dock.
- `makeKeyAndOrderFront:` and `orderOut:` clear the in-progress flag; the later
  Dock completion path skips minimization when that flag has been cleared.

These establish a real asynchronous cancellation mechanism. The old reports
did not capture those native selectors, activation events or the in-progress
flag, so attributing their failure to this mechanism would still be speculation.
No fixed-delay workaround or production behavior change was made.

Exact-revision primary sources:

- [CDP handler](https://raw.githubusercontent.com/chromium/chromium/f842f52ef39fd97b449eb27cff414bf05a98ddce/chrome/browser/devtools/protocol/browser_handler.cc), lines 146-206.
- [Cocoa window](https://raw.githubusercontent.com/chromium/chromium/f842f52ef39fd97b449eb27cff414bf05a98ddce/components/remote_cocoa/app_shim/native_widget_mac_nswindow.mm), lines 852-894.
- [Native minimize forwarding](https://raw.githubusercontent.com/chromium/chromium/f842f52ef39fd97b449eb27cff414bf05a98ddce/ui/views/widget/native_widget_mac.mm), line 869.
- [Native completion delegate](https://raw.githubusercontent.com/chromium/chromium/f842f52ef39fd97b449eb27cff414bf05a98ddce/components/remote_cocoa/app_shim/views_nswindow_delegate.mm), line 322.

## Preservation and checks

No production source, package metadata, tarball, approved shutdown implementation
or historical measurement report was changed. The four exact Chrome PIDs are
73144, 75659, 78844 and 81377; each run's UUID profile appears in its wrapper.
The coordinator records joined SDK driver exit, exact child close, fixture
closure and profile removal.

The final wrapper validates provider success and matching app/window PIDs.
Its separate output is created after the coordinator's preservation snapshot.
The first three wrapper outputs had been reserved empty before the coordinator;
their raw manifests therefore include that new owned output as empty during the
core run. The wrapper writes it afterward. This is not a mutation of historical
input evidence, nor a whole-process immutable-output guarantee.

The final chained check ran the real final-only experiment, script syntax,
typecheck and the three approved shutdown regression files: exit 0 and 12 tests
passed. The full suite was not repeated; its previously disclosed two parallel
integration failures remain unresolved. LSP remains unavailable; no installation,
publish, repack or commit occurred.

```sh
node scripts/native-visibility-investigation.mjs
node scripts/native-visibility-investigation.mjs --post-only
node scripts/native-visibility-investigation.mjs --final-only
```

## Next action

A dedicated hidden-latency runner can now be validated, but must pass a fresh
native gate for each measurement session and continuously retain native hidden
state during its trials. The existing visible-only runner deliberately rejects
hidden state and must not be relabeled as a hidden benchmark.

Start with serialized local scheduled/reactive trials against the actual
compiled runtime and independent fixture ledger. Retain expiry, duplicate,
early-wall-guard and clock-uncertainty evidence. Report small-sample descriptive
results separately from hidden aging, sleep/wake, platform-wide saturation,
trusted input and site acceptance. No hidden latency or SLA result exists from
this investigation.

The observation wrapper's exit 0 means successful observation/cleanup, not a
successful hidden gate. A measurement consumer must inspect `probe.status` and
`nativeGate`, never chain a benchmark solely on this wrapper's exit status.

Independent evidence review approved the bounded investigation:
`.omo/evidence/native-visibility-investigation-review.md`. Approval does not
establish historical causality, minimization reliability or hidden performance.
