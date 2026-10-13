import { z } from "zod";
import { FlashActError } from "./errors.js";

export function decodeRuntime<T>(value: unknown, schema: z.ZodType<T>): T {
  try {
    const decoded: unknown = JSON.parse(z.string().parse(value));
    return schema.parse(decoded);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      throw new FlashActError("INVALID_RESPONSE", "Invalid browser runtime response", { cause: error });
    throw error;
  }
}
