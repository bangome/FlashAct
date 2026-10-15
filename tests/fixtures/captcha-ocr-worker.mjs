import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const mode = process.argv[2];
const ready = () => process.stdout.write("FLASHAct_VISION_READY_1\n");
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (mode === "descendant") {
  spawn(process.execPath, ["-e", `
    process.on("SIGTERM", () => process.stderr.write("descendant-term\\n"));
    const { port1, port2 } = new (require("node:worker_threads").MessageChannel)();
    port1.on("message", () => port2.postMessage("held"));
    process.stderr.write("descendant\\n");
  `], { stdio: ["pipe", "inherit", "inherit"] });
}
if (mode === "ignore-term") {
  process.on("SIGTERM", () => process.stderr.write("term\n"));
}
const input = createInterface({ input: process.stdin });
input.on("line", line => {
  const request = JSON.parse(line);
  if (request.control === "ready") { ready(); return; }
  if (request.control === "exit") { process.exit(0); }
  process.stderr.write("request\n");
  switch (mode) {
    case "hold":
    case "ignore-term":
    case "descendant":
      return;
    case "wrong-id":
      output({ id: request.id + 1, text: "x", confidence: 0.9 });
      return;
    case "bad-confidence":
      output({ id: request.id, text: "x", confidence: 2 });
      return;
    case "multiline":
      output({ id: request.id, text: "x\ny", confidence: 0.9 });
      return;
    case "malformed":
      process.stdout.write("not-json\n");
      return;
    case "oversized":
      process.stdout.write("x".repeat(16 * 1024 + 1));
      return;
    case "native-error":
      output({ id: request.id, error: true });
      return;
    case "empty":
      output({ id: request.id, text: "", confidence: 0 });
      return;
    case "partial":
      process.stdout.write('{"id":');
      process.exit(0);
      return;
    default:
      output({ id: request.id, text: "aB7x", confidence: 0.97 });
  }
});
process.stderr.write("boot\n");
if (mode === "wrong-ready") process.stdout.write("FLASHAct_VISION_READY_1 extra\n");
else if (mode !== "delayed-ready") ready();
