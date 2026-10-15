import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createInterface } from "node:readline";
import { afterEach, expect, it, vi } from "vitest";
import { VisionRecognizer } from "../../src/captcha/ocr.js";

const image = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const owners: VisionRecognizer[] = [];

function fixture(mode = "normal") {
  const events = new EventEmitter();
  const sequence: string[] = [];
  let child: ChildProcessWithoutNullStreams | undefined;
  let starts = 0;
  const barrier = (event: string) => once(events, event, { signal: AbortSignal.timeout(5_000) });
  // Subscribe before process acquisition, including for the earliest boot event.
  const boot = barrier("boot");
  const recognizer = new VisionRecognizer({
    platform: "darwin",
    spawn: () => {
      starts++;
      child = spawn(process.execPath, [new URL("../fixtures/captcha-ocr-worker.mjs", import.meta.url).pathname, mode], {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      createInterface({ input: child.stderr }).on("line", line => events.emit(line));
      child.once("close", () => { sequence.push("close"); });
      return child;
    },
  });
  owners.push(recognizer);
  return {
    recognizer, barrier, boot, sequence,
    get starts() { return starts; },
    get child() {
      if (!child) throw new TypeError("Fixture child has not started");
      return child;
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(owners.splice(0).map(owner => owner.close()));
});

it("waits for exact readiness and shares one persistent child when prepared repeatedly", async () => {
  // Given
  const controlled = fixture("delayed-ready");
  const { recognizer } = controlled;
  let ready = false;
  const preparing = recognizer.prepare().then(() => { ready = true; });
  const shared = recognizer.prepare();
  await controlled.boot;
  // When
  expect(ready).toBe(false);
  controlled.child.stdin.write('{"control":"ready"}\n');
  await preparing;
  await shared;
  const first = await recognizer.recognize(image, new AbortController().signal);
  const second = await recognizer.recognize(image, new AbortController().signal);
  // Then
  expect(first).toEqual({ text: "aB7x", confidence: 0.97 });
  expect(second).toEqual(first);
  expect(controlled.starts).toBe(1);
});

it("returns empty recognition when the native worker declines ambiguous output", async () => {
  // Given
  const { recognizer } = fixture("empty");
  await recognizer.prepare();
  // When
  const result = await recognizer.recognize(image, new AbortController().signal);
  // Then
  expect(result).toEqual({ text: "", confidence: 0 });
});

it.each(["wrong-id", "bad-confidence", "multiline", "malformed", "oversized"])(
  "rejects and joins malformed worker output when mode is %s", async mode => {
    // Given
    const { recognizer, sequence } = fixture(mode);
    await recognizer.prepare();
    // When
    await expect(recognizer.recognize(image, new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    // Then
    expect(sequence).toEqual(["close"]);
    await expect(recognizer.prepare()).rejects.toMatchObject({ code: "INVALID_STATE" });
  },
);

it.each(["native-error", "partial"])("joins failed producer when worker returns %s", async mode => {
  // Given
  const { recognizer, sequence } = fixture(mode);
  await recognizer.prepare();
  // When
  await expect(recognizer.recognize(image, new AbortController().signal)).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
  // Then
  expect(sequence).toEqual(["close"]);
});

it.each(["abort", "close", "deadline"] as const)("stops the actual producer before rejection when stopped by %s", async mode => {
  // Given
  const controlled = fixture("hold");
  const { recognizer, sequence } = controlled;
  await recognizer.prepare();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const aborter = new AbortController();
  const started = controlled.barrier("request");
  const pending = recognizer.recognize(image, aborter.signal).catch((error: unknown) => {
    sequence.push("rejection");
    throw error;
  });
  const rejected = expect(pending).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
  await started;
  // When
  switch (mode) {
    case "abort": aborter.abort(); break;
    case "close": void recognizer.close(); break;
    case "deadline": vi.advanceTimersByTime(5_000); break;
  }
  await expect(recognizer.recognize(image, new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_STATE" });
  await rejected;
  await recognizer.close();
  // Then
  expect(sequence).toEqual(["close", "rejection"]);
  expect(controlled.starts).toBe(1);
});

it("escalates termination and joins actual close when SIGTERM is ignored", async () => {
  // Given
  const controlled = fixture("ignore-term");
  const { recognizer, sequence } = controlled;
  await recognizer.prepare();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const started = controlled.barrier("request");
  const pending = recognizer.recognize(image, new AbortController().signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
  await started;
  const term = controlled.barrier("term");
  // When
  const closing = recognizer.close();
  expect(recognizer.close()).toBe(closing);
  await term;
  expect(sequence).toEqual([]);
  vi.advanceTimersByTime(250);
  await closing;
  await rejected;
  // Then
  expect(controlled.child.signalCode).toBe("SIGKILL");
  expect(sequence).toEqual(["close"]);
});

it("terminates preparation at its bounded deadline when readiness is withheld", async () => {
  // Given
  const controlled = fixture("delayed-ready");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const preparing = controlled.recognizer.prepare();
  const rejected = expect(preparing).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
  await controlled.boot;
  // When
  vi.advanceTimersByTime(30_000);
  await rejected;
  // Then
  expect(controlled.sequence).toEqual(["close"]);
});

it("terminates an inherited-stdio descendant even after the worker leader exits", async () => {
  // Given
  const controlled = fixture("descendant");
  const descendant = controlled.barrier("descendant");
  await controlled.recognizer.prepare();
  await descendant;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const term = controlled.barrier("descendant-term");
  const leaderExited = once(controlled.child, "exit", { signal: AbortSignal.timeout(5_000) });
  // When
  const closing = controlled.recognizer.close();
  await term;
  await leaderExited;
  expect(controlled.sequence).toEqual([]);
  vi.advanceTimersByTime(250);
  await closing;
  // Then
  expect(controlled.sequence).toEqual(["close"]);
});

it("seals and joins preparation when closed before readiness", async () => {
  // Given
  const controlled = fixture("delayed-ready");
  const preparing = controlled.recognizer.prepare();
  const rejected = expect(preparing).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
  await controlled.boot;
  // When
  await controlled.recognizer.close();
  await rejected;
  // Then
  expect(controlled.sequence).toEqual(["close"]);
  await expect(controlled.recognizer.prepare()).rejects.toMatchObject({ code: "INVALID_STATE" });
});

it("rejects unsupported platforms before process acquisition", async () => {
  // Given
  const launch = vi.fn(() => { throw new TypeError("Must not start"); });
  const recognizer = new VisionRecognizer({ platform: "linux", spawn: launch });
  // When
  await expect(recognizer.prepare()).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
  // Then
  expect(launch).not.toHaveBeenCalled();
  await recognizer.close();
});

it("rejects inexact readiness and joins the worker before preparation rejects", async () => {
  // Given
  const { recognizer, sequence } = fixture("wrong-ready");
  // When
  await expect(recognizer.prepare()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  // Then
  expect(sequence).toEqual(["close"]);
});

it("joins a failed real spawn when the worker executable is missing", async () => {
  // Given
  let closed = false;
  const recognizer = new VisionRecognizer({ platform: "darwin", spawn: () => {
    const child = spawn("/flashact-nonexistent-ocr-executable", [], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    child.once("close", () => { closed = true; });
    return child;
  } });
  owners.push(recognizer);
  // When
  await expect(recognizer.prepare()).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
  // Then
  expect(closed).toBe(true);
});

it("seals without starting a worker when closed before preparation", async () => {
  // Given
  const launch = vi.fn(() => { throw new TypeError("Must not start"); });
  const recognizer = new VisionRecognizer({ platform: "darwin", spawn: launch });
  // When
  const closed = recognizer.close();
  await expect(recognizer.prepare()).rejects.toMatchObject({ code: "INVALID_STATE" });
  await closed;
  // Then
  expect(launch).not.toHaveBeenCalled();
});

it("rejects invalid input and concurrent recognition without sending extra requests", async () => {
  // Given
  const controlled = fixture("hold");
  const { recognizer } = controlled;
  await expect(recognizer.recognize(image, new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_STATE" });
  await recognizer.prepare();
  // When
  await expect(recognizer.recognize(new Uint8Array(), new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  await expect(recognizer.recognize(new Uint8Array(4 * 1024 * 1024 + 1), new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  await expect(recognizer.recognize(image, AbortSignal.abort())).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
  const started = controlled.barrier("request");
  const pending = recognizer.recognize(image, new AbortController().signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
  await started;
  await expect(recognizer.recognize(image, new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_STATE" });
  await recognizer.close();
  // Then
  await rejected;
  expect(controlled.starts).toBe(1);
});
