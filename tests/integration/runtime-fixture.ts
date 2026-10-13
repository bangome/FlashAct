import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, test as base } from "vitest";
import { z } from "zod";
import type { ExecutionPlan, JobState } from "../../src/core/types.js";
import { jobStatusSchema, runtimeHandleSchema } from "../../src/core/schema.js";
import { armExpression, installExpression, statusExpression } from "../../src/runtime/index.js";

let browser: Browser | undefined;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 30_000);
afterAll(async () => { await browser?.close(); });

export const test = base.extend<{ readonly page: Page }>({
  page: async ({}, use) => {
    if (!browser) throw new TypeError("Browser fixture was not initialized");
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await page.route("https://runtime.test/**", (route) => route.fulfill({ contentType: "text/html", body: '<button id="action" type="button">Run</button><div id="signal">idle</div>' }));
        await page.goto("https://runtime.test/");
        await page.evaluate(() => {
          document.addEventListener("click", (event) => {
            if (event.target instanceof Element && event.target.id === "action") {
              document.body.dataset["clicks"] = String(Number(document.body.dataset["clicks"] ?? 0) + 1);
              document.body.dataset["trusted"] = String(event.isTrusted);
              document.body.dataset["clickTime"] = String(Date.now());
            }
          });
        });
        await use(page);
    } finally { await context.close(); }
  },
});

export function plan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return { schemaVersion: "1.0", jobId: "runtime-test", name: "runtime test", backend: "playwright",
    target: { tabId: "owned-test-tab", selector: "#action", url: "https://runtime.test/" },
    trigger: { type: "ELEMENT_APPEAR", selector: "#action" }, action: { type: "click" }, timezone: "UTC",
    expiresAt: Date.now() + 10_000, maxExecutions: 1, verification: { timeoutMs: 100 },
    guards: { approvedUrl: "https://runtime.test/", allowIrreversible: false }, ...overrides };
}

export async function install(page: Page, input: ExecutionPlan) {
  const wire: unknown = await page.evaluate(installExpression(input));
  const decoded: unknown = JSON.parse(z.string().parse(wire));
  return runtimeHandleSchema.parse(decoded);
}

export async function arm(page: Page, jobId = "runtime-test") {
  const wire: unknown = await page.evaluate(armExpression(jobId));
  const decoded: unknown = JSON.parse(z.string().parse(wire));
  return jobStatusSchema.parse(decoded);
}

export async function status(page: Page, jobId = "runtime-test") {
  const wire: unknown = await page.evaluate(statusExpression(jobId));
  const decoded: unknown = JSON.parse(z.string().parse(wire));
  return jobStatusSchema.parse(decoded);
}

export async function waitState(page: Page, state: JobState) {
  await page.waitForFunction((expected) => globalThis.__flashactRuntime?.status("runtime-test").state === expected, state, { timeout: 3000 });
  return status(page);
}

export async function clicks(page: Page): Promise<number> {
  return page.evaluate(() => Number(document.body.dataset["clicks"] ?? 0));
}
