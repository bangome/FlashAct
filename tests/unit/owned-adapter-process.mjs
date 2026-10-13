import { writeFileSync } from "node:fs";

// Real child fixture: events, not elapsed delays, establish start and TERM.
process.on("SIGTERM", () => {
  process.send?.("term");
  if (!process.argv.includes("ignore-term")) process.exit(0);
});
if (process.argv.includes("held-stdio")) {
  const { spawn } = await import("node:child_process");
  const descendant = spawn(process.execPath, [new URL(import.meta.url).pathname, "ignore-term"], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  descendant.on("message", message => {
    if (message === "started") { process.send?.("descendant-started"); process.exit(0); }
  });
}
const startedPath = process.argv.find(argument => argument.startsWith("started-path="));
if (startedPath) writeFileSync(startedPath.slice("started-path=".length), JSON.stringify({ pid: process.pid }));
process.send?.("started");
setInterval(() => {}, 60_000);
