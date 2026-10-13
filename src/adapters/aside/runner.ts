import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import type { AsideOptions } from "../browser-adapter.js";
import { FlashActError, assertNever } from "../../utils/errors.js";
import { deadlines } from "../playwright/worker-protocol.js";

export type AsideCommandRunner = (executable: string, args: readonly string[]) => Promise<string>;

export const execAside: AsideCommandRunner = (executable, args) => new Promise((resolve, reject) => {
  execFile(executable, [...args], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
    if (error) reject(new FlashActError("ADAPTER_ERROR", "Aside CLI command failed", { cause: error }));
    else resolve(stdout);
  });
});

/** Exact official CLI subprocesses are retained until close, never worker-owned. */
export class ManagedAsideRunner {
  private sealed = false;
  private stopping: Promise<void> | undefined;
  private readonly active = new Map<ChildProcess, {
    readonly closed: Promise<void>;
    readonly terminate: () => void;
  }>();

  constructor(private readonly lost?: () => void) {}

  readonly run: AsideCommandRunner = (executable, args) => {
    if (this.sealed) return Promise.reject(new FlashActError("ADAPTER_ERROR", "Owned Aside runner terminated"));
    const child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let resolveClose: () => void = () => {};
    const closed = new Promise<void>(resolve => { resolveClose = resolve; });
    let terminated = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const terminate = (): void => {
      if (terminated) return;
      terminated = true;
      child.kill("SIGTERM");
      force = setTimeout(() => child.kill("SIGKILL"), deadlines.grace);
    };
    this.active.set(child, { closed, terminate });
    return new Promise((resolve, reject) => {
      let output = "";
      let failed = false;
      const timer = setTimeout(() => { this.lost?.(); void this.stop(); }, deadlines.operation);
      child.on("error", () => { failed = true; });
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (Buffer.byteLength(output) > 8 * 1024 * 1024) { failed = true; this.lost?.(); void this.stop(); }
      });
      child.stderr.resume();
      child.once("close", code => {
        clearTimeout(timer);
        if (force) clearTimeout(force);
        this.active.delete(child);
        resolveClose();
        // Reject only on actual close, including spawn failure and force exit.
        if (failed || terminated || code !== 0) reject(new FlashActError("ADAPTER_ERROR", "Owned Aside command terminated or failed"));
        else resolve(output);
      });
    });
  };

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.sealed = true;
    const commands = [...this.active.values()];
    this.stopping = Promise.all(commands.map(command => command.closed)).then(() => {});
    for (const command of commands) command.terminate();
    return this.stopping;
  }
}

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
