import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { BrowserAdapter } from "../adapters/browser-adapter.js";
import type { ExecutionPlan } from "../core/types.js";
import { FlashActError } from "../utils/errors.js";
import { captureRegionSchema } from "./schema.js";
import type { CaptchaStatus, CaptureRegion } from "./types.js";
import type { CaptchaRecognizer } from "./ocr.js";
import { captchaCancelExpression, captchaFillExpression, captchaInstallExpression, captchaReadExpression } from "./runtime.js";

const viewSchema = z.strictObject({
  state: z.enum(["waiting", "ready", "filled", "submitted", "verified", "invalid", "timeout", "cancelled", "unknown"]),
  inputs: z.number().int().min(0).max(1), submissions: z.number().int().min(0).max(1),
  region: captureRegionSchema.exactOptional(),
});
const imageSchema = z.string().min(1).max(3 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/);

/** One OCR, one fill, at most one explicit submit. Observation renewal is never an action retry. */
export class CaptchaTask {
  private readonly key = randomUUID();
  private readonly controller = new AbortController();
  private status: CaptchaStatus = { state: "PREPARING", inputs: 0, submissions: 0 };
  private installed = false;
  private mutating = false;
  private started: number | undefined;

  constructor(private readonly plan: ExecutionPlan, private readonly adapter: BrowserAdapter,
    private readonly recognizer: CaptchaRecognizer, private readonly report: (status: CaptchaStatus) => void,
    private readonly eligible: () => Promise<void>) {}

  private emit(update: Partial<CaptchaStatus>): void {
    this.status = { ...this.status, ...update };
    this.report(this.status);
  }
  private active(): void {
    if (this.controller.signal.aborted) throw new FlashActError("INVALID_STATE", "Captcha task stopped");
  }
  private evaluate(expression: string): Promise<unknown> {
    if (!this.adapter.evaluateCaptcha) throw new FlashActError("ADAPTER_ERROR", "Adapter has no captcha evaluation boundary");
    return this.adapter.evaluateCaptcha(this.plan.jobId, this.plan.target.tabId, expression);
  }
  async prepare(): Promise<void> {
    if (!this.adapter.capture || !this.adapter.evaluateCaptcha)
      throw new FlashActError("ADAPTER_ERROR", "Adapter does not support captcha capture");
    this.emit({ state: "PREPARING" });
    try {
      await this.recognizer.prepare();
      this.active();
      if (await this.evaluate(captchaInstallExpression(this.key, this.plan)) !== true)
        throw new FlashActError("GUARD_REJECTED", "Captcha installation rejected");
      this.installed = true;
      this.active();
      this.emit({ state: "WAITING" });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.emit({ state: this.controller.signal.aborted ? "CANCELLED" : "FAILED", error: "OCR_UNAVAILABLE" });
      await this.release();
      throw error;
    }
  }
  cancel(): void { this.controller.abort(); }

  private async capture(region: CaptureRegion): Promise<Buffer> {
    this.active();
    const capture = this.adapter.capture;
    if (!capture) throw new FlashActError("ADAPTER_ERROR", "Missing screenshot boundary");
    const image = Buffer.from(imageSchema.parse(await capture.call(this.adapter, this.plan.target.tabId, region)), "base64");
    this.active();
    if (image.length > 2 * 1024 * 1024 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new FlashActError("INVALID_RESPONSE", "Captcha capture is not a bounded PNG");
    return image;
  }
  private async ready(region: CaptureRegion): Promise<boolean> {
    this.active();
    const current = viewSchema.parse(await this.evaluate(captchaReadExpression(this.key)));
    this.active();
    return current.state === "ready" && JSON.stringify(current.region) === JSON.stringify(region);
  }
  async run(): Promise<void> {
    const config = this.plan.captcha;
    if (!config) throw new FlashActError("INVALID_PLAN", "Missing captcha configuration");
    try {
      let current = viewSchema.parse(await this.evaluate(captchaReadExpression(this.key)));
      while (current.state === "waiting") {
        this.active();
        current = viewSchema.parse(await this.evaluate(captchaReadExpression(this.key)));
      }
      this.active();
      if (current.state !== "ready" || !current.region) {
        this.finishView(current); return;
      }
      await this.eligible();
      this.active();
      if (!await this.ready(current.region)) {
        this.emit({ state: "FAILED", error: "CHALLENGE_CHANGED" }); return;
      }
      this.started = performance.now();
      this.emit({ state: "CAPTURING" });
      let stage = performance.now();
      const image = await this.capture(current.region);
      const captureMs = performance.now() - stage;
      if (!await this.ready(current.region)) {
        this.emit({ state: "FAILED", error: "CHALLENGE_CHANGED" }); return;
      }
      this.emit({ state: "RECOGNIZING", timing: { captureMs } });
      stage = performance.now();
      const recognized = await this.recognizer.recognize(image, this.controller.signal);
      this.active();
      const confidence = z.number().min(0).max(1).parse(recognized.confidence);
      this.emit({ confidence, timing: { ...this.status.timing, recognitionMs: performance.now() - stage } });
      if (confidence < config.minConfidence) { this.emit({ state: "FAILED", error: "LOW_CONFIDENCE" }); return; }
      const text = config.alphabet === "uppercase-alphanumeric" ? recognized.text.toUpperCase() : recognized.text;
      const alphabet = config.alphabet === "digits" ? /^[0-9]+$/ : config.alphabet === "uppercase-alphanumeric"
        ? /^[A-Z0-9]+$/ : /^[A-Za-z0-9]+$/;
      if (text.length !== config.length || !alphabet.test(text)) { this.emit({ state: "FAILED", error: "INVALID_TEXT" }); return; }
      if (!await this.ready(current.region)) {
        this.emit({ state: "FAILED", error: "CHALLENGE_CHANGED" }); return;
      }
      const fresh = await this.capture(current.region);
      if (createHash("sha256").update(fresh).digest("hex") !== createHash("sha256").update(image).digest("hex")) {
        this.emit({ state: "FAILED", error: "CHALLENGE_CHANGED" }); return;
      }
      this.active();
      stage = performance.now();
      this.mutating = true;
      current = viewSchema.parse(await this.evaluate(captchaFillExpression(this.key, text)));
      this.emit({ inputs: current.inputs, submissions: current.submissions,
        timing: { ...this.status.timing, inputMs: performance.now() - stage } });
      if (current.state === "filled" && !config.successSelector) { this.emit({ state: "FILLED" }); return; }
      if (current.state === "submitted" || current.state === "filled") {
        this.emit({ state: current.submissions ? "SUBMITTED" : "FILLED" });
        do {
          this.active();
          current = viewSchema.parse(await this.evaluate(captchaReadExpression(this.key)));
        } while (current.state === "submitted" || current.state === "filled" || current.state === "waiting");
      }
      this.finishView(current);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.emit({ state: this.mutating ? "UNKNOWN" : this.controller.signal.aborted ? "CANCELLED" : "FAILED",
        ...(this.controller.signal.aborted ? {} : { error: "CONNECTION_LOST" as const }) });
    } finally {
      if (this.started !== undefined)
        this.emit({ timing: { ...this.status.timing, totalMs: performance.now() - this.started } });
      await this.release();
    }
  }
  private async release(): Promise<void> {
    try {
      if (this.installed) {
        this.installed = false;
        await this.evaluate(captchaCancelExpression(this.key));
      }
    } catch (error) {
      // Document/transport loss can make remote listener removal unobservable.
      // Closing the owned reader below still joins its actual producer.
      if (!(error instanceof Error)) throw error;
    } finally { await this.adapter.closeCaptcha?.(this.plan.jobId); }
  }
  private finishView(current: z.infer<typeof viewSchema>): void {
    this.emit({ inputs: current.inputs, submissions: current.submissions,
      state: current.state === "verified" ? "VERIFIED" : current.state === "cancelled"
        ? this.mutating ? "UNKNOWN" : "CANCELLED" : this.mutating ? "UNKNOWN" : "FAILED",
      ...(current.state === "timeout" ? { error: "TIMEOUT" as const }
        : current.state === "invalid" ? { error: "GUARD_REJECTED" as const } : {}) });
  }
}
