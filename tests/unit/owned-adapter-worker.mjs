import { parentPort, workerData } from "node:worker_threads";
import { writeFileSync } from "node:fs";

if (workerData.fixture === "initialization-failure") throw new Error("Fixture initialization failure: private details");
const { generation } = workerData;
let status = { jobId: "held", state: "VALIDATED", executions: 0, updatedAt: 1 };
const observe = () => parentPort.postMessage({ kind: "status", generation, status });
parentPort.on("message", request => {
  let result;
  switch (request.method) {
    case "connect":
      if (workerData.fixture === "connect-failure") {
        parentPort.postMessage({ kind: "error", generation, id: request.id, code: "ADAPTER_ERROR" });
        return;
      }
      if (workerData.fixture === "held-connect") {
        writeFileSync(workerData.startedPath, "started");
        return;
      }
      break;
    case "installRuntime":
      status = { ...status, jobId: request.plan.jobId };
      observe();
      result = { jobId: status.jobId, documentId: "fixture-document" };
      break;
    case "arm":
      status = { ...status, state: "WAITING", updatedAt: 2 };
      observe();
      break;
    case "getStatus":
    case "evaluate":
      status = { ...status, state: request.argument === "hold-execution" ? "DISPATCHED" : "WAITING",
        executions: request.argument === "hold-execution" ? 1 : 0, updatedAt: 123 };
      observe();
      return; // Actual producer intentionally withholds the RPC reply.
    case "wake":
      result = status;
      break;
    case "cancel":
      status = { ...status, state: "CANCELLED", updatedAt: 124 };
      observe();
      if (workerData.fixture === "held-cancel") return;
      break;
    case "disconnect":
      status = { ...status, state: "CANCELLED", updatedAt: 125 };
      observe();
      if (workerData.fixture === "held-disconnect") return;
      break;
    case "listTabs":
      result = [{ id: "fixture-tab", url: "about:blank", title: "Fixture" }];
      break;
    default:
      parentPort.postMessage({ kind: "error", generation, id: request.id, code: "INVALID_STATE" });
      return;
  }
  parentPort.postMessage({ kind: "reply", generation, id: request.id, result });
});
