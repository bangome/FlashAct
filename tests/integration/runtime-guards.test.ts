import { expect } from "vitest";
import { z } from "zod";
import { targetInfoSchema } from "../../src/core/schema.js";
import { inspectExpression } from "../../src/runtime/index.js";
import { arm, clicks, install, plan, test, waitState } from "./runtime-fixture.js";

test.for(["remove", "replace", "selector", "detach-reattach"] as const)("rejects cached target after %s", async (change, { page }) => {
  // Given
  await install(page, plan({ trigger: { type: "TEXT_CHANGE", selector: "#signal" } }));
  await arm(page);
  // When
  await page.locator("#action").evaluate((element, mode) => {
    switch (mode) {
      case "remove": element.remove(); break;
      case "replace": element.replaceWith(element.cloneNode(true)); break;
      case "selector": element.id = "changed"; break;
      case "detach-reattach": element.remove(); document.body.append(element); break;
    }
    const signal = document.querySelector("#signal");
    if (signal) signal.textContent = "ready";
  }, change);
  const result = await waitState(page, "FAILED");
  // Then
  expect(result.executions).toBe(0);
  expect(await clicks(page)).toBe(0);
});

test.for(["disabled", "hidden"] as const)("fails safely when action is %s at dispatch", async (attribute, { page }) => {
  // Given
  await page.locator("#action").evaluate((element, name) => element.setAttribute(name, ""), attribute);
  await install(page, plan());
  // When
  const result = await arm(page);
  // Then
  expect(result.state).toBe("FAILED");
  expect(await clicks(page)).toBe(0);
});

test("rejects an ambiguous target at arm", async ({ page }) => {
  // Given
  await page.locator("#action").evaluate((element) => document.body.append(element.cloneNode(true)));
  await install(page, plan());
  // When
  const result = await arm(page);
  // Then
  expect(result.state).toBe("FAILED");
  expect(await clicks(page)).toBe(0);
});

test("rejects zero-area action targets", async ({ page }) => {
  // Given
  await page.locator("#action").evaluate((element) => { element.setAttribute("style", "width:0;height:0;padding:0;border:0;overflow:hidden"); });
  await install(page, plan());
  // When
  const result = await arm(page);
  // Then
  expect(result.state).toBe("FAILED");
  expect(await clicks(page)).toBe(0);
});

test("rejects missing action targets without a matching APPEAR leaf", async ({ page }) => {
  // Given
  await page.locator("#action").evaluate((element) => element.remove());
  await install(page, plan({ trigger: { type: "TEXT_CHANGE", selector: "#signal" } }));
  // When
  const result = await arm(page);
  // Then
  expect(result.state).toBe("FAILED");
  expect(result.executions).toBe(0);
});

test("rejects ambiguity introduced after arm without substituting the target", async ({ page }) => {
  // Given
  await install(page, plan({ trigger: { type: "TEXT_CHANGE", selector: "#signal" } }));
  await arm(page);
  // When
  await page.locator("#action").evaluate((element) => {
    document.body.prepend(element.cloneNode(true));
    const signal = document.querySelector("#signal"); if (signal) signal.textContent = "ready";
  });
  await waitState(page, "FAILED");
  // Then
  expect(await clicks(page)).toBe(0);
});

test.for(["target", "trigger", "watchRoot", "verification"] as const)("rejects invalid %s CSS during installation", async (field, { page }) => {
  // Given
  const base = plan();
  const input = field === "target" ? { ...base, target: { ...base.target, selector: "[" } }
    : field === "trigger" ? { ...base, trigger: { type: "ELEMENT_APPEAR" as const, selector: "[" } }
      : field === "watchRoot" ? { ...base, target: { ...base.target, watchRoot: "[" } }
        : { ...base, verification: { selector: "[", timeoutMs: 100 } };
  // When / Then
  await expect(install(page, input)).rejects.toThrow();
});

test("rejects the wrong approved live URL at install", async ({ page }) => {
  // Given
  const base = plan();
  const input = { ...base, target: { ...base.target, url: "https://runtime.test/other" }, guards: { ...base.guards, approvedUrl: "https://runtime.test/other" } };
  // When / Then
  await expect(install(page, input)).rejects.toThrow();
});

test.for(["default-button", "submit-input", "external-anchor"] as const)("blocks unapproved irreversible %s", async (kind, { page }) => {
  // Given
  await page.locator("#action").evaluate((element, type) => {
    const form = document.createElement("form");
    switch (type) {
      case "default-button": element.removeAttribute("type"); element.replaceWith(form); form.append(element); break;
      case "submit-input": {
        const input = document.createElement("input"); input.type = "submit"; input.id = "action"; element.replaceWith(form); form.append(input); break;
      }
      case "external-anchor": {
        const anchor = document.createElement("a"); anchor.href = "https://external.test/"; anchor.id = "action"; anchor.textContent = "External"; element.replaceWith(anchor); break;
      }
    }
  }, kind);
  await install(page, plan());
  // When
  const result = await arm(page);
  // Then
  expect(result.state).toBe("FAILED");
  expect(result.executions).toBe(0);
});

test("allows explicitly approved submit and reports inspect safety flags", async ({ page }) => {
  // Given
  await page.locator("#action").evaluate((element) => {
    const form = document.createElement("form"); element.removeAttribute("type"); element.replaceWith(form); form.append(element);
    form.addEventListener("submit", (event) => event.preventDefault());
  });
  const input = plan({ guards: { approvedUrl: "https://runtime.test/", allowIrreversible: true } });
  await install(page, input);
  const wire: unknown = await page.evaluate(inspectExpression("#action"));
  const decoded: unknown = JSON.parse(z.string().parse(wire));
  expect(targetInfoSchema.parse(decoded)).toMatchObject({ count: 1, visible: true, enabled: true, irreversible: true });
  // When
  const result = await arm(page);
  // Then
  expect(result.state).toBe("VERIFIED");
  expect(await clicks(page)).toBe(1);
});
