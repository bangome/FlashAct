# Text-image CAPTCHA integration

FlashAct supports one text-image CAPTCHA following the original single-shot
click. It does not solve image grids, sliders or third-party iframe challenges.
There is no universal success guarantee. Main click `state` and `executions`
keep their original meaning; main `VERIFIED` is never CAPTCHA success.

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
| `imageSelector` | `--captcha-image` | Required text-image element |
| `inputSelector` | `--captcha-input` | Required empty input |
| `submitSelector` | `--captcha-submit` | Optional explicit submit action |
| `successSelector` | `--captcha-success` | Required when submitting; action-specific observed success |
| `length` | `--captcha-length` | Integer 1..32, default 6 |
| `alphabet` | `--captcha-alphabet` | `uppercase-alphanumeric` (default), `alphanumeric`, `digits` |
| `minConfidence` | `--captcha-min-confidence` | Number 0..1, default 0.8 |
| `timeoutMs` | `--captcha-timeout-ms` | Integer 100..120000, default 15000 |

The CLI rejects partial configurations and dangling options, including tuning
flags without both required selectors and submission without a success selector.
Without `submitSelector`, the operation fills once and does not submit.
Only supply submit when that exact action is explicitly intended and an
observable success selector is available. An already-present receipt is not
new success evidence.

For an already inspected and approved tab, using its exact tab ID and URL:

```sh
fa --watch --backend "$BACKEND" --tab "$TAB_ID" \
  --url "$URL" --approved-url "$URL" --selector '#reserve' \
  --action click --when enabled \
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
original click has `executions: 1`. Events detect the challenge rather than an
agent polling the page. Capture uses cropped image pixels, not DOM text.
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
| `WAITING` | Waiting for the eligible challenge |
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

No retry, reconnect or rearm occurs on failure, uncertainty or connection loss.
Inspect application evidence manually; never automatically create a duplicate
job. Keep the foreground owner alive through the nested CAPTCHA outcome, then
stop it and await shutdown. Leave existing user tabs, including booking tabs,
intact.

## October 15, 2026 local acceptance

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

The package root exports `CaptchaPlan`, `CaptchaStatus`, `CaptureRegion`,
`captchaPlanSchema`, `captchaStatusSchema`, `captureRegionSchema`,
`CaptchaRecognizer`, `CaptchaRecognition` and `VisionRecognizer`. The recognition
interface's text is an internal OCR value, not status/log output.
