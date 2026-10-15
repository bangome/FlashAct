import { parentPort, workerData } from "node:worker_threads";
import { PlaywrightAdapter } from "./index.js";
import { initializationSchema, requestSchema, transportStatus } from "./worker-protocol.js";
import type { WorkerEvent, WorkerRequest } from "./worker-protocol.js";
import { FlashActError, assertNever } from "../../utils/errors.js";

const port = parentPort;
if (!port) throw new FlashActError("INTERNAL_ERROR", "Adapter worker requires a parent port");
const initialization = initializationSchema.parse(workerData);
const send = (event: WorkerEvent): void => port.postMessage(event);
const adapter = new PlaywrightAdapter({
  endpoint: initialization.endpoint,
  ...(initialization.tabId === undefined ? {} : { tabId: initialization.tabId }),
  ...(initialization.url === undefined ? {} : { url: initialization.url }),
}, {
  artifactsDir: initialization.artifactsDir,
  observation: status => send({ kind: "status", generation: initialization.generation, status: transportStatus(status) }),
  lost: () => send({ kind: "lost", generation: initialization.generation }),
});

async function execute(request: WorkerRequest): Promise<unknown> {
  switch (request.method) {
    case "connect": return adapter.connect();
    case "listTabs": return adapter.listTabs();
    case "selectTab": return adapter.selectTab(request.argument);
    case "inspectTarget": return adapter.inspectTarget(request.argument);
    case "installRuntime": return adapter.installRuntime(request.plan);
    case "arm": return adapter.arm(request.plan);
    case "wake": return adapter.wake(request.argument);
    case "cancel": return adapter.cancel(request.argument);
    case "getStatus": return adapter.getStatus(request.argument);
    case "evaluate": return adapter.evaluate(request.argument);
    case "evaluateCaptcha": return adapter.evaluateCaptcha(request.jobId, request.tabId, request.argument);
    case "capture": return adapter.capture(request.tabId, request.region);
    case "disconnect": return adapter.disconnect();
    default: return assertNever(request);
  }
}

// Deliberately no queue: a withheld SDK operation cannot block cancel or wake.
port.on("message", (value: unknown) => {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success || parsed.data.generation !== initialization.generation) return;
  const request = parsed.data;
  void execute(request).then(
    result => send({ kind: "reply", generation: request.generation, id: request.id, result }),
    (error: unknown) => send({ kind: "error", generation: request.generation, id: request.id,
      code: error instanceof FlashActError ? error.code : "ADAPTER_ERROR" }),
  );
});
