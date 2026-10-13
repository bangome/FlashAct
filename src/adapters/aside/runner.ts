import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import type { AsideOptions } from "../browser-adapter.js";
import { FlashActError, assertNever } from "../../utils/errors.js";

export type AsideCommandRunner = (executable: string, args: readonly string[]) => Promise<string>;

export const execAside: AsideCommandRunner = (executable, args) => new Promise((resolve, reject) => {
  execFile(executable, [...args], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
    if (error) reject(new FlashActError("ADAPTER_ERROR", "Aside CLI command failed", { cause: error }));
    else resolve(stdout);
  });
});

const envelopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("value"), value: z.unknown() }),
  z.strictObject({ kind: z.literal("undefined") }),
  z.strictObject({ kind: z.literal("error"), message: z.string() }),
]);

export function decodeAsideOutput(stdout: string, marker: string): unknown {
  const lines = stripVTControlCharacters(stdout).split(/\r?\n/).filter((line) => line.startsWith(marker));
  if (lines.length !== 1 || !lines[0]) throw new FlashActError("INVALID_RESPONSE", "Missing or ambiguous Aside result marker");
  try {
    const decoded: unknown = JSON.parse(lines[0].slice(marker.length));
    const envelope = envelopeSchema.parse(decoded);
    switch (envelope.kind) {
      case "value":
        if (!Object.hasOwn(envelope, "value")) throw new FlashActError("INVALID_RESPONSE", "Aside value envelope has no value");
        return envelope.value;
      case "undefined": return undefined;
      case "error": throw new FlashActError("ADAPTER_ERROR", envelope.message);
      default: return assertNever(envelope);
    }
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new FlashActError("INVALID_RESPONSE", "Malformed Aside result envelope", { cause: error });
    }
    throw error;
  }
}

export class AsideTransport {
  private readonly executable: string;
  constructor(private readonly options: AsideOptions, private readonly runner: AsideCommandRunner = execAside) {
    this.executable = options.executable ?? (process.platform === "win32" ? "aside.exe" : "aside");
    // execFile cannot safely execute Windows shell shims; use the installed native executable.
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(this.executable)) {
      throw new FlashActError("ADAPTER_ERROR", "Aside requires a native .exe executable on Windows, not a shell shim");
    }
  }

  async version(): Promise<void> { await this.runner(this.executable, ["--version"]); }

  async repl(body: string): Promise<unknown> {
    const marker = `__FLASHACT_${randomUUID()}__`;
    const code = `await (async () => { try { const result = await (async () => { ${body} })(); console.log(${JSON.stringify(marker)} + JSON.stringify(result === undefined ? {kind:"undefined"} : {kind:"value",value:result})); } catch (error) { console.log(${JSON.stringify(marker)} + JSON.stringify({kind:"error",message:error instanceof Error ? error.message : String(error)})); } })()`;
    const args = ["repl"];
    if (this.options.account !== undefined) args.push("--account", this.options.account);
    if (this.options.host !== undefined) args.push("--host", this.options.host);
    args.push(code);
    try { return decodeAsideOutput(await this.runner(this.executable, args), marker); }
    catch (error) {
      if (error instanceof FlashActError) throw error;
      if (error instanceof Error) throw new FlashActError("ADAPTER_ERROR", "Aside transport failed", { cause: error });
      throw error;
    }
  }
}
