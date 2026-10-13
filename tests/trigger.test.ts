import { describe, expect, it } from "vitest";
import { triggerSchema } from "../src/index.js";
import type { Trigger } from "../src/index.js";

const leaf = { type: "ELEMENT_ENABLE", selector: "#go" } as const;

function nestedTrigger(depth: number): Trigger {
  return depth === 1 ? leaf : { type: "AND", conditions: [nestedTrigger(depth - 1)] };
}

describe("trigger boundary", () => {
  it.each([
    { type: "SCHEDULED", at: 1_800_000_000_000 },
    { type: "ELEMENT_APPEAR", selector: "#go" },
    { type: "ELEMENT_ENABLE", selector: "#go" },
    { type: "ELEMENT_VISIBLE", selector: "#go" },
    { type: "ATTRIBUTE_CHANGE", selector: "#go", attribute: "disabled" },
    { type: "ATTRIBUTE_CHANGE", selector: "#go", attribute: "value", value: "" },
    { type: "TEXT_CHANGE", selector: "#go" },
    { type: "TEXT_CHANGE", selector: "#go", value: "" },
    { type: "AND", conditions: [leaf] },
    { type: "OR", conditions: [leaf, { type: "AND", conditions: [leaf] }] },
  ])("preserves valid trigger %j", (input) => {
    // Given: a supported trigger shape.
    // When
    const result = triggerSchema.parse(input);
    // Then
    expect(result).toEqual(input);
  });

  it.each([
    { type: "SCHEDULED", at: "1800000000000" },
    { type: "SCHEDULED", at: -1 },
    { type: "SCHEDULED", at: 0.5 },
    { type: "SCHEDULED", at: Number.NaN },
    { type: "ELEMENT_APPEAR", selector: " " },
    { type: "ELEMENT_ENABLE" },
    { type: "ATTRIBUTE_CHANGE", selector: "#go" },
    { type: "ATTRIBUTE_CHANGE", selector: "#go", attribute: " " },
    { type: "TEXT_CHANGE", selector: "#go", value: null },
    { type: "TEXT_CHANGE", selector: "#go", value: undefined },
    { type: "AND", conditions: [] },
    { type: "OR", conditions: [] },
    { type: "AND", conditions: [null] },
    { type: "OR", conditions: [leaf], selector: "#go" },
    { type: "CLICK", selector: "#go" },
  ])("rejects malformed trigger %j", (input) => {
    // Given: untrusted trigger input.
    // When
    const result = triggerSchema.safeParse(input);
    // Then
    expect(result.success).toBe(false);
  });

  it.each([{ depth: 8, accepted: true }, { depth: 9, accepted: false }])(
    "enforces depth at $depth levels", ({ depth, accepted }) => {
      // Given
      const input = nestedTrigger(depth);
      // When
      const result = triggerSchema.safeParse(input);
      // Then
      expect(result.success).toBe(accepted);
    },
  );

  it.each([{ width: 32, accepted: true }, { width: 33, accepted: false }])(
    "enforces composite width at $width conditions", ({ width, accepted }) => {
      // Given
      const input = { type: "OR", conditions: Array.from({ length: width }, () => leaf) };
      // When
      const result = triggerSchema.safeParse(input);
      // Then
      expect(result.success).toBe(accepted);
    },
  );

  it("rejects cyclic input without overflowing the stack", () => {
    // Given
    const input: { type: "AND"; conditions: unknown[] } = { type: "AND", conditions: [] };
    input.conditions.push(input);
    // When
    const result = triggerSchema.safeParse(input);
    // Then
    expect(result.success).toBe(false);
  });
});
