export type CaptchaPlan = {
  readonly imageSelector: string;
  readonly inputSelector: string;
  readonly submitSelector?: string;
  readonly successSelector?: string;
  readonly alphabet: "uppercase-alphanumeric" | "alphanumeric" | "digits";
  readonly length: number;
  readonly minConfidence: number;
  readonly timeoutMs: number;
};

export type CaptureRegion = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type CaptchaStatus = {
  readonly state: "PREPARING" | "WAITING" | "CAPTURING" | "RECOGNIZING" | "FILLED" | "SUBMITTED"
    | "VERIFIED" | "FAILED" | "UNKNOWN" | "CANCELLED";
  readonly inputs: number;
  readonly submissions: number;
  readonly confidence?: number;
  readonly error?: "LOW_CONFIDENCE" | "INVALID_TEXT" | "CHALLENGE_CHANGED" | "GUARD_REJECTED"
    | "TIMEOUT" | "CONNECTION_LOST" | "OCR_UNAVAILABLE";
  readonly timing?: {
    readonly captureMs?: number;
    readonly recognitionMs?: number;
    readonly inputMs?: number;
    readonly totalMs?: number;
  };
};
