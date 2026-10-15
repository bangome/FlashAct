import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { FlashActError } from "../utils/errors.js";
import { visionSource } from "./vision-source.js";

export type CaptchaRecognition = {
  readonly text: string;
  readonly confidence: number;
};

export interface CaptchaRecognizer {
  prepare(): Promise<void>;
  recognize(image: Uint8Array, signal: AbortSignal): Promise<CaptchaRecognition>;
  close(): Promise<void>;
}

type VisionDependencies = {
  readonly platform?: NodeJS.Platform;
  /** Must return a detached process-group leader with piped stdio. */
  readonly spawn?: () => ChildProcessWithoutNullStreams;
};

const READY = "FLASHAct_VISION_READY_1";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const responseSchema = z.union([
  z.strictObject({
    id: z.number().int().positive().safe(),
    text: z.string().max(256).refine(text => !/\s/u.test(text)),
    confidence: z.number().finite().min(0).max(1),
  }),
  z.strictObject({ id: z.number().int().positive().safe(), error: z.literal(true) }),
]);

type PendingRecognition = {
  readonly id: number;
  readonly resolve: (value: CaptchaRecognition) => void;
  readonly reject: (error: FlashActError) => void;
  readonly cleanup: () => void;
};

/** A single-use process owner. Abort and deadlines terminate, never retry, work. */
export class VisionRecognizer implements CaptchaRecognizer {
  private child: ChildProcessWithoutNullStreams | undefined;
  private childClosed = false;
  private preparation: Promise<void> | undefined;
  private preparationResolve: (() => void) | undefined;
  private preparationReject: ((error: FlashActError) => void) | undefined;
  private preparationTimer: ReturnType<typeof setTimeout> | undefined;
  private joined: Promise<void> = Promise.resolve();
  private shutdown: Promise<void> | undefined;
  private sealed = false;
  private ready = false;
  private nextId = 0;
  private pending: PendingRecognition | undefined;
  private buffer = Buffer.alloc(0);

  constructor(private readonly dependencies: VisionDependencies = {}) {}

  prepare(): Promise<void> {
    if (this.sealed) return Promise.reject(new FlashActError("INVALID_STATE", "OCR provider is closed"));
    if (this.preparation) return this.preparation;
    if ((this.dependencies.platform ?? process.platform) !== "darwin") {
      this.sealed = true;
      return Promise.reject(new FlashActError("ADAPTER_ERROR", "Vision OCR requires macOS"));
    }
    this.preparation = new Promise<void>((resolve, reject) => {
      this.preparationResolve = resolve;
      this.preparationReject = reject;
    });
    try {
      const child = this.dependencies.spawn?.() ?? spawn("/usr/bin/swift", ["-e", visionSource], {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      this.child = child;
      this.joined = new Promise<void>(resolve => {
        child.once("close", () => {
          this.childClosed = true;
          resolve();
          void this.stop(new FlashActError("ADAPTER_ERROR", "OCR worker closed"));
        });
      });
      child.once("error", () => { void this.stop(new FlashActError("ADAPTER_ERROR", "OCR worker failed")); });
      child.stdin.on("error", () => { void this.stop(new FlashActError("ADAPTER_ERROR", "OCR input failed")); });
      child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
      child.stdout.on("error", () => { void this.stop(new FlashActError("ADAPTER_ERROR", "OCR output failed")); });
      // Drain diagnostics without retaining or logging potentially sensitive output.
      child.stderr.resume();
      this.preparationTimer = setTimeout(() => {
        void this.stop(new FlashActError("ADAPTER_ERROR", "OCR readiness deadline exceeded"));
      }, 30_000);
    } catch {
      // Process acquisition is an external boundary; do not expose argv or diagnostics.
      void this.stop(new FlashActError("ADAPTER_ERROR", "OCR worker could not start"));
    }
    return this.preparation;
  }

  recognize(image: Uint8Array, signal: AbortSignal): Promise<CaptchaRecognition> {
    if (this.sealed || !this.ready || !this.child) {
      return Promise.reject(new FlashActError("INVALID_STATE", "OCR provider is not ready"));
    }
    if (this.pending) return Promise.reject(new FlashActError("INVALID_STATE", "OCR recognition is already pending"));
    if (signal.aborted) return Promise.reject(new FlashActError("ADAPTER_ERROR", "OCR recognition aborted"));
    if (image.byteLength > MAX_IMAGE_BYTES || image.byteLength < PNG_SIGNATURE.length ||
        !Buffer.from(image.subarray(0, PNG_SIGNATURE.length)).equals(PNG_SIGNATURE)) {
      return Promise.reject(new FlashActError("INVALID_RESPONSE", "OCR requires a bounded PNG image"));
    }
    const child = this.child;
    const id = ++this.nextId;
    return new Promise<CaptchaRecognition>((resolve, reject) => {
      const abort = () => { void this.stop(new FlashActError("ADAPTER_ERROR", "OCR recognition aborted")); };
      const timer = setTimeout(() => {
        void this.stop(new FlashActError("ADAPTER_ERROR", "OCR recognition deadline exceeded"));
      }, 5_000);
      this.pending = { id, resolve, reject, cleanup: () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      } };
      signal.addEventListener("abort", abort, { once: true });
      child.stdin.write(`${JSON.stringify({ id, image: Buffer.from(image).toString("base64") })}\n`, error => {
        if (error) void this.stop(new FlashActError("ADAPTER_ERROR", "OCR request failed"));
      });
    });
  }

  close(): Promise<void> {
    return this.stop(new FlashActError("ADAPTER_ERROR", "OCR provider closed"));
  }

  private receive(chunk: Buffer): void {
    if (this.sealed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline: number;
    while ((newline = this.buffer.indexOf(10)) !== -1) {
      if (newline > MAX_LINE_BYTES) {
        void this.stop(new FlashActError("INVALID_RESPONSE", "OCR response exceeded limit"));
        return;
      }
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      if (!this.ready && line === READY) {
        this.ready = true;
        clearTimeout(this.preparationTimer);
        this.preparationResolve?.();
        this.preparationResolve = undefined;
        this.preparationReject = undefined;
        continue;
      }
      let value: unknown;
      try { value = JSON.parse(line); }
      catch {
        void this.stop(new FlashActError("INVALID_RESPONSE", "OCR response is not valid JSON"));
        return;
      }
      const parsed = responseSchema.safeParse(value);
      const pending = this.pending;
      if (!this.ready || !parsed.success || !pending || parsed.data.id !== pending.id) {
        void this.stop(new FlashActError("INVALID_RESPONSE", "OCR response does not match protocol"));
        return;
      }
      if ("error" in parsed.data) {
        void this.stop(new FlashActError("ADAPTER_ERROR", "Vision OCR could not recognize image"));
        return;
      }
      pending.cleanup();
      this.pending = undefined;
      pending.resolve({ text: parsed.data.text, confidence: parsed.data.confidence });
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      void this.stop(new FlashActError("INVALID_RESPONSE", "OCR response exceeded limit"));
    }
  }

  private stop(error: FlashActError): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.sealed = true; // Seal synchronously, before any caller can enqueue more work.
    clearTimeout(this.preparationTimer);
    this.pending?.cleanup();
    const child = this.child;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    if (child?.pid !== undefined && !this.childClosed) {
      const pid = child.pid;
      // Swift's driver may own a frontend interpreter. Signal the whole owned
      // group, even after the driver exits, then join inherited stdio closure.
      const kill = (signal: NodeJS.Signals) => {
        try { process.kill(-pid, signal); }
        catch (failure) {
          if (!(failure instanceof Error && "code" in failure && failure.code === "ESRCH")) throw failure;
        }
      };
      kill("SIGTERM");
      escalation = setTimeout(() => { kill("SIGKILL"); }, 250);
    }
    this.shutdown = this.joined.then(() => {
      clearTimeout(escalation);
      this.buffer = Buffer.alloc(0);
      this.preparationReject?.(error);
      this.preparationReject = undefined;
      this.preparationResolve = undefined;
      this.pending?.reject(error);
      this.pending = undefined;
    });
    return this.shutdown;
  }
}
