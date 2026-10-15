# Text-image CAPTCHA integration

FlashAct can wait for a text-image CAPTCHA to appear, recognize it and fill once
without an opener click or another agent turn. It also supports the original
post-click companion. Image grids, sliders and third-party iframe challenges are
unsupported. There is no universal success guarantee. Main `VERIFIED` is never
CAPTCHA success; inspect the nested outcome.

## Preparation and selectors

The default `VisionRecognizer` uses local macOS native Vision through Swift.
macOS and `/usr/bin/swift` must be available. Preparation compiles/warms the
worker before arming, not at the click deadline. Leave enough preparation time.
No API keys, external OCR service or model downloads are required.
The default recognizer admits one active recognition per engine; overlapping
requests reject rather than restarting it. Use separate owners or an injected
recognizer when concurrent OCR is required.

Configure exact, unique CSS selectors on the approved target document:

| Plan field | CLI flag | Requirement/default |
| --- | --- | --- |
| `screenSelector` | `--captcha-screen` | Required active CAPTCHA-specific screen/container |
| `imageSelector` | `--captcha-image` | Required text-image element |
| `inputSelector` | `--captcha-input` | Required empty input |
| `submitSelector` | `--captcha-submit` | Optional explicit submit action |
| `successSelector` | `--captcha-success` | Required when submitting; action-specific observed success |
| `length` | `--captcha-length` | Integer 1..32, default 6 |
| `alphabet` | `--captcha-alphabet` | `uppercase-alphanumeric` (default), `alphanumeric`, `digits` |
| `minConfidence` | `--captcha-min-confidence` | Number 0..1, default 0.8 |
| `timeoutMs` | `--captcha-timeout-ms` | Integer 100..120000, default 15000 |

The CLI rejects partial configurations and dangling options, including tuning
flags without all three required selectors and submission without a success selector.
Without `submitSelector`, the operation fills once and does not submit.
Only supply submit when that exact action is explicitly intended and an
observable success selector is available. An already-present receipt is not
new success evidence.

Identify the CAPTCHA screen from actual page inspection, not from the fact that
a click occurred or an image/input pair exists. The required `screenSelector`
must match a unique visible/enabled CAPTCHA-specific container containing the
configured image, input and optional submit. Whole-document body/html selections
reject. If a reliable screen marker is unavailable, inspect/classify the page
before arming; this is not a general visual semantic classifier. Previously
configured CAPTCHA plans must add this field; there is no guessed fallback.
Losing/replacing the bound screen during recognition prevents input.

For an already inspected and approved tab, using its exact tab ID and URL:

### Wait for an image without clicking

```sh
fa --watch --backend "$BACKEND" --tab "$TAB_ID" \
  --url "$URL" --approved-url "$URL" --action captcha --when appear \
  --captcha-screen '#captcha-dialog' \
  --captcha-image '#captcha-image' --captcha-input '#captcha-answer'
```

Arm this before the challenge is expected. OCR compiles/warms during preparation,
then the owned process stays alive. The image may initially be missing or hidden;
FlashAct waits for the confirmed CAPTCHA screen, contained fields and image load, captures pixels, recognizes
and fills once without another agent round trip. An already-visible image can
be processed immediately. `--selector` defaults to `--captcha-image`; an explicit
different selector rejects. No opener, reserve button or image is clicked.

Waiting for the confirmed screen and ready fields is bounded by plan expiry
(the reactive CLI default is 24 hours) and any stricter primary verification.
Only after screen confirmation and image/input readiness does `captcha.timeoutMs`
bound recognition, input and optional verification, also capped by plan expiry.
Cancel when the authorized waiting window ends; no retry or rearm is automatic.

### Click, then recognize an image

```sh
fa --watch --backend "$BACKEND" --tab "$TAB_ID" \
  --url "$URL" --approved-url "$URL" --selector '#reserve' \
  --action click --when enabled \
  --captcha-screen '#captcha-dialog' \
  --captcha-image '#captcha-image' --captcha-input '#captcha-answer' \
  --captcha-length 6 --captcha-alphabet uppercase-alphanumeric \
  --captcha-min-confidence 0.8 --captcha-timeout-ms 15000
```

Replace every selector with the actual inspected selector; these names are not
site discovery. To submit explicitly, add
`--captcha-submit '#captcha-submit' --captcha-success '#captcha-accepted'`.
Primary click verification remains separate. With `--verify-selector`, an
omitted `--verify-timeout-ms` defaults to `max(5000, captcha.timeoutMs + 2000)`.
An explicit timeout smaller than `captcha.timeoutMs` rejects. Without a primary
verification selector, its normal default remains 5000 ms.

## Detection, capture and outcomes

Appearance detection is installed before arming and activated only after the
chosen action has `executions: 1`. On click plans that means the original click;
on CAPTCHA-only plans it means a workflow dispatch marker, not a DOM click.
Dispatch alone is never CAPTCHA evidence: screen confirmation gates pixel capture
and recognition even if ordinary images and inputs are already visible.
CAPTCHA-only readiness uses DOM/resize/load/animation events and scheduled/expiry
deadlines, without a recurring readiness timer or agent polling the page.
Capture uses cropped image pixels, not DOM text.
On Aside, FlashAct captures the viewport and crops locally because the tested
Aside screenshot API ignored clip origins. Only the resulting region is sent to
OCR; full viewport pixels are not logged or saved. The image must be inside the
visible viewport, and viewport movement during capture rejects. PNG cropping
accounts for device scale and document scroll. Run `npm ci` when updating from
an earlier checkout to install the added PNG codec.
The operation refuses a stale/changed image, ambiguous selectors or an already
filled input. Recognized text must satisfy the configured alphabet, exact length
and minimum confidence before input; neither guesswork nor retries are promised.

The host owns nested `JobStatus.captcha`. CLI foreground output, status and logs
retain its changes independently of the original click lifecycle:

| `captcha.state` | Meaning |
| --- | --- |
| `PREPARING` | Local OCR preparation |
| `WAITING` | Waiting for the confirmed CAPTCHA screen and ready contained fields |
| `CAPTURING` | Cropped pixel capture |
| `RECOGNIZING` | Local OCR |
| `FILLED` | One input completed; not submission or success |
| `SUBMITTED` | One explicit submit dispatched; not success |
| `VERIFIED` | Configured CAPTCHA success observed |
| `FAILED`, `UNKNOWN`, `CANCELLED` | Separate unsuccessful/uncertain/cancelled outcome |

`inputs` and `submissions` are each 0 or 1. Optional `confidence` and `error`
describe the decision without disclosing recognized text. Optional `timing`
contains `captureMs`, `recognitionMs`, `inputMs` and `totalMs` when available;
these measure individual stages and total work, not a latency guarantee.
CAPTCHA text and images must not be printed or logged.
On CAPTCHA-only jobs, main `executions: 1` counts workflow dispatch only;
`clickEpochMs` is absent, and actual input/submission counts remain nested.
Main `VERIFIED` with nested `WAITING` or `RECOGNIZING` is not completion.

No retry, reconnect or rearm occurs on failure, uncertainty or connection loss.
Inspect application evidence manually; never automatically create a duplicate
job. Keep the foreground owner alive through the nested CAPTCHA outcome, then
stop it and await shutdown. Leave existing user tabs, including booking tabs,
intact.

## October 15, 2026 independent-wait acceptance

Authored localhost runs of the compiled CLI and actual Aside waited with the
image hidden, then used native Vision after an external appearance event. Each
observed zero opener/image clicks, one input, one explicit submit and one
independently accepted HTTP request. Example appearance-to-input measurements
were 233.1 ms for the CLI and 466.3 ms for Aside after preparation. These are
individual local samples, not guaranteed latency. Owned processes and tabs were
joined/closed without using an existing booking session.

Regression cases cover absent/hidden images, fixed-size and intrinsic-size
images with held PNG responses, first load versus later same-URL reload,
cancellation before appearance, higher-ancestor opacity/visibility changes after
initial resize delivery, and no repeated input after later mutations.

## October 15, 2026 original post-click acceptance

The authored localhost challenge was captured from actual pixels, recognized by
native Vision and accepted once by an independent HTTP handler. After OCR
preparation, one Playwright measurement took 98.4 ms total (capture 26.2 ms,
recognition 38.8 ms, input 5.3 ms). One real Aside measurement took 422.7 ms total
(capture 172.8 ms, recognition 55.3 ms, input 19.8 ms). Total includes additional
freshness capture/guard checks and verification. These are single local samples
of a clear six-character challenge, not percentiles or a production-site SLA.

Actual compiled CLI execution and real Aside both reached nested `VERIFIED`
with one input, one submission and one accepted HTTP request. Foreground
shutdown joined its browser/OCR owners, and the Aside test closed only its
authored tab. Tests also cover changed pixels, nonempty input, invalid/uncertain
OCR output, cancellation before dispatch/during OCR, verification timeout and
an aliased submit selector that would otherwise repeat the original action.
Descendant/sibling targets, nested actionable roles and input-time reparenting
are rejected using all shared actionable ancestors, not only the closest
control. The final normal parallel suite passed 622 tests with seven opt-in
Aside skips; the separate real Aside test also passed. Independent review's
original-action-reuse finding was reproduced, fixed and approved on closure.
No existing booking session was resumed or submitted during acceptance.

## MCP and SDK

No new MCP tools are needed. `flashact_list_backends` exposes `captcha.planSchema`
and local Vision requirements without opening a browser. Pass the following
optional field inside the full plan to existing `flashact_create_job`:

```json
{
  "captcha": {
    "screenSelector": "#captcha-dialog",
    "imageSelector": "#captcha-image",
    "inputSelector": "#captcha-answer",
    "submitSelector": "#captcha-submit",
    "successSelector": "#captcha-accepted",
    "alphabet": "uppercase-alphanumeric",
    "length": 6,
    "minConfidence": 0.8,
    "timeoutMs": 15000
  }
}
```

This fragment is not a full execution plan. Create, validate and arm remain
separate calls. If the full plan has `verification.selector`, set
`verification.timeoutMs >= captcha.timeoutMs`; MCP does not choose CLI defaults.
Read `captcha` through existing status/result tools, separately from main state.
For independent waiting, set `action: { "type": "captcha" }`, use the same image
selector in `target.selector`, and use an `ELEMENT_APPEAR` trigger for that image.
`flashact_list_backends.captcha.standaloneAction` advertises this action.

The package root exports `CaptchaPlan`, `CaptchaStatus`, `CaptureRegion`,
`captchaPlanSchema`, `captchaStatusSchema`, `captureRegionSchema`,
`CaptchaRecognizer`, `CaptchaRecognition` and `VisionRecognizer`. The recognition
interface's text is an internal OCR value, not status/log output.
