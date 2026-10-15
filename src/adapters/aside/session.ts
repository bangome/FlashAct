import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type { AsideOptions } from "../browser-adapter.js";
import { FlashActError } from "../../utils/errors.js";
import { deadlines } from "../playwright/worker-protocol.js";
import { decodeAsideOutput } from "./runner.js";
import type { AsideCommandRunner } from "./runner.js";
import { captureRegionSchema } from "../../captcha/schema.js";
import type { CaptureRegion } from "../../captcha/types.js";
import { cropViewportPng, viewportSchema } from "../../captcha/crop.js";

const replySchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});

// Runtime.evaluate has a measured 30-second CDP deadline inside the REPL timeout.
export const asideChangeRead = { leaseMs: 20_000, rpcTimeoutMs: 25_000 } as const;

export type AsideSessionDependencies = {
  readonly transport?: () => StdioClientTransport;
};

/** One official MCP process owns a persistent REPL scope, not the browser. */
export class AsideSession {
  private readonly client = new Client({ name: "flashact", version: "0.1.0" });
  private transport: StdioClientTransport | undefined;
  private connecting: Promise<void> | undefined;
  private closed: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private sealed = false;

  constructor(private readonly options: AsideOptions = {}, private readonly lost?: () => void,
    private readonly dependencies: AsideSessionDependencies = {}) {}

  readonly run: AsideCommandRunner = async (_executable, args) => {
    this.admission();
    switch (args[0]) {
      case "--version":
        await this.connect();
        return z.string().parse(this.client.getServerVersion()?.version);
      case "repl":
        return this.execute(z.string().parse(args.at(-1)), deadlines.operation);
      default: throw new FlashActError("ADAPTER_ERROR", "Aside MCP accepts only version and REPL operations");
    }
  };

  get pid(): number | undefined { return this.transport?.pid ?? undefined; }

  async evaluate(tabId: string, expression: string, timeoutMs: number = deadlines.operation): Promise<unknown> {
    const body = `const target = getTabByTargetId(${JSON.stringify(tabId)}) ?? await attachBrowserTab(${JSON.stringify(tabId)});
      return await target.evaluate(${JSON.stringify(expression)});`;
    return this.read(body, timeoutMs);
  }

  async capture(tabId: string, region: CaptureRegion): Promise<string> {
    captureRegionSchema.parse(region);
    const result = z.strictObject({ image: z.string(), viewport: viewportSchema }).parse(
      await this.read(`const target = getTabByTargetId(${JSON.stringify(tabId)}) ?? await attachBrowserTab(${JSON.stringify(tabId)});
      const view = () => ({width:innerWidth,height:innerHeight,scrollX,scrollY});
      const before = await target.evaluate(view);
      const image = Buffer.from(await target.screenshot({type:"png"})).toString("base64");
      const after = await target.evaluate(view);
      if (JSON.stringify(before)!==JSON.stringify(after)) throw new Error("Viewport changed during capture");
      return {image,viewport:before};`, deadlines.operation));
    return cropViewportPng(result.image, region, result.viewport);
  }

  private async read(body: string, timeoutMs: number): Promise<unknown> {
    const marker = `__FLASHACT_${randomUUID()}__`;
    const code = `await (async () => { try { const value = await (async () => { ${body} })();
      console.log(${JSON.stringify(marker)} + JSON.stringify(value === undefined ? {kind:"undefined"} : {kind:"value",value}));
      } catch(error) { console.log(${JSON.stringify(marker)} + JSON.stringify({kind:"error",message:String(error)})); } })()`;
    return decodeAsideOutput(await this.execute(code, timeoutMs), marker);
  }

  private admission(): void {
    if (this.sealed) throw new FlashActError("ADAPTER_ERROR", "Aside MCP session stopped; no reconnect or retry");
  }

  private connect(): Promise<void> {
    this.admission();
    this.connecting ??= this.acquire();
    return this.connecting;
  }

  private async acquire(): Promise<void> {
    const args = ["mcp"];
    if (this.options.account !== undefined) args.push("--account", this.options.account);
    if (this.options.host !== undefined) args.push("--host", this.options.host);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    const transport = this.dependencies.transport?.() ?? new StdioClientTransport({
      command: this.options.executable ?? (process.platform === "win32" ? "aside.exe" : "aside"),
      args, env, stderr: "pipe",
    });
    this.transport = transport;
    let resolveClosed: () => void = () => {};
    this.closed = new Promise(resolve => { resolveClosed = resolve; });
    // SDK close can return just after SIGKILL; its actual close event is the join.
    transport.onclose = () => {
      resolveClosed();
      if (!this.sealed) this.fail();
    };
    transport.stderr?.on("data", () => undefined);
    const timer = setTimeout(() => this.fail(), deadlines.startup);
    try {
      await this.client.connect(transport);
      this.admission();
      const tools = await this.client.listTools();
      if (!tools.tools.some(tool => tool.name === "repl"))
        throw new FlashActError("ADAPTER_ERROR", "Aside MCP does not provide REPL");
    } catch (error) {
      await this.stop();
      if (error instanceof FlashActError) throw error;
      throw new FlashActError("ADAPTER_ERROR", "Aside MCP acquisition failed", { cause: error });
    } finally { clearTimeout(timer); }
  }

  private async execute(code: string, timeoutMs: number): Promise<string> {
    await this.connect();
    this.admission();
    const timer = setTimeout(() => this.fail(), timeoutMs);
    try {
      const result = await this.client.callTool({ name: "repl", arguments: {
        title: "FlashAct guarded browser state", code,
      } }, undefined, { timeout: timeoutMs + deadlines.grace * 4 });
      if (this.sealed) { await this.stop(); this.admission(); }
      const reply = replySchema.safeParse(result);
      if (!reply.success) throw new FlashActError("INVALID_RESPONSE", "Invalid Aside MCP reply", { cause: reply.error });
      if (reply.data.isError) throw new FlashActError("ADAPTER_ERROR", "Aside MCP REPL failed");
      const text = reply.data.content.map(part => part.text).join("\n");
      if (Buffer.byteLength(text) > 8 * 1024 * 1024)
        throw new FlashActError("INVALID_RESPONSE", "Aside MCP response limit exceeded");
      return text;
    } catch (error) {
      this.fail();
      await this.stop();
      if (error instanceof FlashActError) throw error;
      throw new FlashActError("ADAPTER_ERROR", "Aside MCP operation failed", { cause: error });
    } finally { clearTimeout(timer); }
  }

  private fail(): void {
    if (this.sealed) return;
    void this.stop();
    this.lost?.();
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.sealed = true;
    this.stopping = (async () => {
      await this.client.close();
      if (this.closed) await this.closed;
    })();
    return this.stopping;
  }
}
