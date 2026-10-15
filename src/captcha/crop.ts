import { PNG } from "pngjs";
import { z } from "zod";
import type { CaptureRegion } from "./types.js";
import { captureRegionSchema } from "./schema.js";
import { FlashActError } from "../utils/errors.js";

export const viewportSchema = z.strictObject({
  width: z.number().finite().positive(), height: z.number().finite().positive(),
  scrollX: z.number().finite(), scrollY: z.number().finite(),
});
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Aside currently ignores screenshot clip origins. Crop its viewport locally. */
export function cropViewportPng(encoded: string, region: CaptureRegion, viewport: z.infer<typeof viewportSchema>): string {
  captureRegionSchema.parse(region); viewportSchema.parse(viewport);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 24 || bytes.length > 6 * 1024 * 1024 || !bytes.subarray(0, 8).equals(signature))
    throw new FlashActError("INVALID_RESPONSE", "Invalid viewport PNG");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0 || width * height > 16_000_000)
    throw new FlashActError("INVALID_RESPONSE", "Viewport pixel budget exceeded");
  const x = Math.floor((region.x - viewport.scrollX) * width / viewport.width);
  const y = Math.floor((region.y - viewport.scrollY) * height / viewport.height);
  const cropWidth = Math.ceil(region.width * width / viewport.width);
  const cropHeight = Math.ceil(region.height * height / viewport.height);
  if (x < 0 || y < 0 || x + cropWidth > width || y + cropHeight > height)
    throw new FlashActError("GUARD_REJECTED", "Captcha must be within the visible viewport");
  const image = PNG.sync.read(bytes);
  const cropped = new PNG({ width: cropWidth, height: cropHeight });
  PNG.bitblt(image, cropped, x, y, cropWidth, cropHeight, 0, 0);
  return PNG.sync.write(cropped).toString("base64");
}
