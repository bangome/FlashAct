import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { ExecutionPlan, JobStatus } from "../../src/core/types.js";
import type { JobEngine } from "../../src/core/engine.js";
import { parsePlan } from "../../src/core/schema.js";

/** Authored challenge: the answer is checked independently by the HTTP service. */
export async function captchaFixture() {
  const answer = "K7M2X9";
  const attempts: string[] = [];
  const path = `/captcha-${randomUUID()}`;
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === `${path}/accept`) {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        attempts.push(body);
        response.writeHead(body === answer && attempts.length === 1 ? 200 : 409).end();
      });
      return;
    }
    if (request.url !== path) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width">
      <title>FlashAct authored captcha</title><style>
      body{font-family:system-ui;margin:24px;background:#fafafa;color:#111}
      main{max-width:420px}canvas{display:block;background:white;margin:16px 0;border:0}
      input,button{font:18px system-ui;padding:10px;max-width:100%;box-sizing:border-box}
      [hidden]{display:none!important}</style></head><body><main>
      <h1>Local captcha test</h1><button id="reserve" type="button"><span id="reserve-label">Open challenge</span><span id="reserve-icon">+</span></button>
      <section id="challenge" hidden><canvas id="image" width="240" height="80"></canvas>
      <label>Challenge text <input id="answer" type="text" autocomplete="off"></label>
      <button id="submit" type="button">Verify</button></section><div id="result" aria-live="polite"></div>
      </main><script>
      window.clicks=0;window.submits=0;window.receiptStatus=0;
      const canvas=document.querySelector('#image');
      window.drawChallenge=function(text){const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,240,80);
      ctx.fillStyle='#111';ctx.font='bold 40px monospace';ctx.textBaseline='middle';ctx.fillText(text,15,42);};
      drawChallenge(${JSON.stringify(answer)});
      document.querySelector('#reserve').addEventListener('click',()=>{window.clicks++;document.querySelector('#challenge').hidden=false;});
      document.querySelector('#submit').addEventListener('click',async()=>{
        window.submits++;const response=await fetch(${JSON.stringify(`${path}/accept`)},{method:'POST',body:document.querySelector('#answer').value});
        window.receiptStatus=response.status;
        if(response.ok){const node=document.createElement('p');node.id='success';node.textContent='Accepted once';document.querySelector('#result').append(node);}
      });
      </script></body></html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return {
    answer, attempts, url: `http://127.0.0.1:${address.port}${path}`,
    close: async () => {
      const closed = once(server, "close");
      server.close(); server.closeAllConnections();
      await closed;
    },
  };
}

export function captchaPlan(tabId: string, url: string): ExecutionPlan {
  return parsePlan({
    schemaVersion: "1.0", jobId: randomUUID(), name: "Local captcha", backend: "playwright",
    target: { tabId, selector: "#reserve", url }, trigger: { type: "ELEMENT_ENABLE", selector: "#reserve" },
    action: { type: "click" }, timezone: "UTC", expiresAt: Date.now() + 60000, maxExecutions: 1,
    verification: { timeoutMs: 5000 }, guards: { approvedUrl: url, allowIrreversible: false },
    captcha: { imageSelector: "#image", inputSelector: "#answer", submitSelector: "#submit", successSelector: "#success" },
  });
}

export function captchaOutcome(engine: JobEngine): { readonly result: Promise<JobStatus>; dispose(): void } {
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout>;
  const result = new Promise<JobStatus>((resolve, reject) => {
    timer = setTimeout(() => { unsubscribe(); reject(new Error("Captcha did not finish")); }, 25000);
    unsubscribe = engine.subscribe(status => {
      if (status.captcha && ["VERIFIED", "FAILED", "UNKNOWN", "CANCELLED"].includes(status.captcha.state)) {
        clearTimeout(timer); unsubscribe(); resolve(status);
      }
    });
  });
  return { result, dispose: () => { clearTimeout(timer); unsubscribe(); } };
}
