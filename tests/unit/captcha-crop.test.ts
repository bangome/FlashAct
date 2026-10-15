import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { cropViewportPng } from "../../src/captcha/crop.js";

describe("Aside viewport pixel cropping", () => {
  it("uses the requested origin, retina scale and current document scroll", () => {
    // Given
    const image = new PNG({ width: 80, height: 60 });
    const offset = (12 * 80 + 10) * 4;
    image.data.set([12, 34, 56, 255], offset);
    // When
    const crop = PNG.sync.read(Buffer.from(cropViewportPng(PNG.sync.write(image).toString("base64"),
      { x: 105, y: 206, width: 8, height: 6 }, { width: 40, height: 30, scrollX: 100, scrollY: 200 }), "base64"));
    // Then
    expect([crop.width, crop.height]).toEqual([16, 12]);
    expect([...crop.data.subarray(0, 4)]).toEqual([12, 34, 56, 255]);
  });
  it("rejects off-screen regions instead of capturing a different area", () => {
    // Given
    const image = new PNG({ width: 20, height: 20 });
    const encoded = PNG.sync.write(image).toString("base64");
    // When / Then
    expect(() => cropViewportPng(encoded, { x: 15, y: 15, width: 10, height: 10 },
      { width: 20, height: 20, scrollX: 0, scrollY: 0 })).toThrowError("Captcha must be within the visible viewport");
  });
});
