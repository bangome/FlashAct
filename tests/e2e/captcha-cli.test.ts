import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jobStatusSchema } from "../../src/core/schema.js";
import { captchaFixture } from "../fixtures/captcha.js";
import { bounded, serviceChild } from "../fixtures/control-service.js";

describe.runIf(process.platform === "darwin")("compiled captcha CLI", () => {
  it.each(["click", "captcha"])("publishes native OCR after %s and joins browser/OCR on shutdown", async action => {
    // Given
    const fixture = await captchaFixture({ externalAppearance: action === "captcha" });
    const home = await mkdtemp(join(tmpdir(), "flashact-captcha-cli-"));
    const service = serviceChild(["--watch", "--launch", "--headless", "--url", fixture.url,
      "--approved-url", fixture.url, "--action", action,
      ...(action === "click" ? ["--selector", "#reserve", "--when", "enabled"] : ["--when", "appear"]),
      "--captcha-image", "#image", "--captcha-input", "#answer", "--captcha-submit", "#submit",
      "--captcha-success", "#success", "--verify-selector", "#success"], home);
    let buffer = "";
    let finish = () => {};
    let fail: (error: Error) => void = () => {};
    const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    const status = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = jobStatusSchema.parse(JSON.parse(line));
        if (parsed.captcha?.state === "VERIFIED") finish();
        else if (parsed.captcha && ["FAILED", "UNKNOWN", "CANCELLED"].includes(parsed.captcha.state))
          fail(new Error(`Captcha CLI ended ${JSON.stringify(parsed.captcha)}`));
      }
    };
    service.child.stdout.on("data", status);
    void service.exited.then(() => fail(new Error(`CLI exited before captcha: ${service.output().stderr}`)));
    try {
      // When
      if (action === "captcha") {
        await service.waitForState("WAITING");
        expect(service.messages.some(value => jobStatusSchema.parse(value).captcha?.state === "RECOGNIZING")).toBe(false);
        await bounded(fixture.reveal(), "challenge appearance connection");
      }
      await bounded(completed, "native captcha CLI verification");
      const result = service.messages.map(value => jobStatusSchema.parse(value)).find(item => item.captcha?.state === "VERIFIED");
      service.child.kill("SIGTERM");
      // Then
      expect(await bounded(service.exited, "captcha foreground shutdown")).toEqual({ code: 0, signal: null });
      expect(result).toMatchObject({ executions: 1, captcha: { state: "VERIFIED", inputs: 1, submissions: 1 } });
      expect(fixture.attempts).toEqual([fixture.answer]);
      expect(fixture.receipts).toEqual([expect.objectContaining({
        clicks: action === "click" ? 1 : 0, imageClicks: 0, inputs: 1,
        appearanceToInputMs: expect.any(Number),
      })]);
      if (action === "captcha") expect(result?.timing?.clickEpochMs).toBeUndefined();
      expect(service.output().stderr).toBe("");
      await expect(access(join(home, "engine.json"))).rejects.toMatchObject({ code: "ENOENT" });
      console.log(JSON.stringify({ captchaAcceptance: "cli", action, captcha: result?.captcha,
        effects: fixture.attempts.length, receipts: fixture.receipts }));
    } finally {
      service.child.stdout.off("data", status);
      await service.stop(); await fixture.close(); await rm(home, { recursive: true, force: true });
    }
  }, 45000);
});
