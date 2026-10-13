import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { FlashActError } from "../../utils/errors.js";
import { deadlines } from "./worker-protocol.js";

export type ChromeSpawner = (executable: string, args: readonly string[]) => ChildProcess;

export class ChromeOwner {
  readonly endpoint: Promise<string>;
  readonly exited: Promise<void>;
  readonly closed: Promise<void>;
  readonly child: ChildProcess;
  private stopping: Promise<void> | undefined;
  private failEndpoint: (error: Error) => void = () => {};

  constructor(readonly profile: string, headless: boolean,
    spawnBrowser: ChromeSpawner = (executable, args) => spawn(executable, [...args], {
      detached: true, stdio: ["ignore", "ignore", "pipe"],
    })) {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new FlashActError("ADAPTER_ERROR", "Owned browser process groups require Darwin or Linux");
    }
    let announced: string | undefined;
    let reading = false;
    let dirty = false;
    let settled = false;
    let resolveEndpoint: (endpoint: string) => void = () => {};
    let rejectEndpoint: (error: Error) => void = () => {};
    this.endpoint = new Promise((resolve, reject) => { resolveEndpoint = resolve; rejectEndpoint = reject; });
    const watcher = watch(profile, () => { void bind(); });
    const timer = setTimeout(() => {
      this.failEndpoint(new FlashActError("ADAPTER_ERROR", "Owned Chrome startup deadline"));
      void this.stop();
    }, deadlines.startup);
    const finish = (error?: Error, endpoint?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      if (error) rejectEndpoint(error);
      else if (endpoint) resolveEndpoint(endpoint);
    };
    this.failEndpoint = error => finish(error);
    const bind = async (): Promise<void> => {
      if (!announced || settled) return;
      if (reading) { dirty = true; return; }
      reading = true;
      try {
        const activePort = await readFile(join(profile, "DevToolsActivePort"), "utf8");
        const [port, path] = activePort.trim().split(/\r?\n/);
        const address = new URL(announced);
        if (address.protocol !== "ws:" || address.hostname !== "127.0.0.1"
          || address.port !== port || address.pathname !== path) {
          finish(new FlashActError("ADAPTER_ERROR", "Owned Chrome endpoint binding failed"));
        } else finish(undefined, announced);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          finish(new FlashActError("ADAPTER_ERROR", "Owned Chrome endpoint binding failed"));
        }
      } finally {
        reading = false;
        if (dirty) { dirty = false; void bind(); }
      }
    };
    try {
      this.child = spawnBrowser(chromium.executablePath(), [
        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
        `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
        ...(headless ? ["--headless"] : []), "about:blank",
      ]);
    } catch (error) {
      watcher.close();
      clearTimeout(timer);
      throw error;
    }
    this.exited = new Promise(resolve => {
      this.child.once("exit", () => resolve());
      this.child.once("error", () => { if (this.child.pid === undefined) resolve(); });
    });
    this.closed = new Promise(resolve => this.child.once("close", () => resolve()));
    this.child.once("error", () => finish(new FlashActError("ADAPTER_ERROR", "Owned Chrome failed to start")));
    this.child.once("exit", () => {
      finish(new FlashActError("ADAPTER_ERROR", "Owned Chrome exited before endpoint acquisition"));
    });
    let stderr = "";
    this.child.stderr?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderr = (stderr + chunk.toString()).slice(-16_384);
      const endpoint = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1];
      if (endpoint) { announced = endpoint; void bind(); }
    });
    // A partial acquisition is owned even if nobody awaits its endpoint.
    void this.endpoint.catch((error: unknown) => { if (!(error instanceof Error)) throw error; });
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.failEndpoint(new FlashActError("ADAPTER_ERROR", "Owned Chrome acquisition terminated"));
    this.stopping = this.join();
    return this.stopping;
  }

  private signal(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try { process.kill(-pid, signal); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }

  private async join(): Promise<void> {
    this.signal("SIGTERM");
    const timer = setTimeout(() => this.signal("SIGKILL"), deadlines.grace);
    try { await Promise.all([this.exited, this.closed]); }
    finally { clearTimeout(timer); }
  }
}
