export type FlashActErrorCode =
  | "INVALID_PLAN"
  | "ADAPTER_ERROR"
  | "INVALID_RESPONSE"
  | "GUARD_REJECTED"
  | "JOB_NOT_FOUND"
  | "INVALID_STATE"
  | "INTERNAL_ERROR";

export class FlashActError extends Error {
  override readonly name = "FlashActError";

  constructor(
    readonly code: FlashActErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function assertNever(value: never): never {
  throw new FlashActError("INTERNAL_ERROR", "Unexpected contract variant", {
    cause: value,
  });
}
