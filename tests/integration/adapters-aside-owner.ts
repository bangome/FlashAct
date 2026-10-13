import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { FlashActError } from "../../src/utils/errors.js";
import { decodeAsideOutput } from "../../src/adapters/aside/runner.js";

export class AsideFixtureOwner {
  private readonly child = spawn("aside", ["repl"], { stdio: ["pipe", "pipe", "pipe"] });
  private readonly exited = new Promise<{ readonly code: number | null; readonly signal: string | null }>((resolve, reject) => {
    this.child.once("exit", (code, signal) => resolve({ code, signal }));
    this.child.once("error", reject);
  });

  async command(body: string): Promise<unknown> {
    const marker = `__ASIDE_OWNER_${randomUUID()}__`;
    return new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => finish(new FlashActError("ADAPTER_ERROR", "Interactive Aside fixture owner timed out")), 120_000);
      const finish = (error?: Error, value?: unknown): void => {
        clearTimeout(timer);
        this.child.stdout.off("data", receive);
        this.child.off("exit", exit);
        if (error) reject(error); else resolve(value);
      };
      const exit = (): void => finish(new FlashActError("ADAPTER_ERROR", "Interactive Aside fixture owner exited during command"));
      const receive = (chunk: Buffer): void => {
        output += stripVTControlCharacters(chunk.toString());
        if (output.length > 8 * 1024 * 1024) { finish(new FlashActError("INVALID_RESPONSE", "Owner output limit exceeded")); return; }
        for (const line of output.split(/\r?\n/).slice(0, -1)) {
          const index = line.indexOf(marker);
          if (index < 0 || !line.slice(index + marker.length).startsWith("{")) continue;
          try { finish(undefined, decodeAsideOutput(line.slice(index), marker)); }
          catch (error) { if (error instanceof Error) finish(error); else reject(error); }
          return;
        }
      };
      this.child.stdout.on("data", receive);
      this.child.once("exit", exit);
      this.child.stdin.write(`await (async () => { try { const value = await (async () => { ${body} })(); console.log(${JSON.stringify(marker)} + JSON.stringify(value === undefined ? {kind:"undefined"} : {kind:"value",value})); } catch (error) { console.log(${JSON.stringify(marker)} + JSON.stringify({kind:"error",message:String(error)})); } })()\n`);
    });
  }

  async stop() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGTERM"), 5_000);
    try { return await this.exited; }
    finally { clearTimeout(timer); }
  }
}
