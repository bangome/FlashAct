import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = resolve(process.argv[2] ?? 'dist/cli/index.js');
const exec = promisify(execFile);
await mkdir('artifacts/qa', { recursive: true });
const home = await mkdtemp(join(tmpdir(), 'flashact-manual-'));
const profile = await mkdtemp(join(tmpdir(), 'flashact-manual-browser-'));
const fixture = createServer((_request, response) => response.end('<button id="reserve" type="button" disabled onclick="window.clicks=(window.clicks||0)+1">Reserve local fixture</button>'));
await new Promise(resolveReady => fixture.listen(0, '127.0.0.1', resolveReady));
const address = fixture.address();
if (!address || typeof address === 'string') throw new Error('Fixture has no port');
const url = `http://127.0.0.1:${address.port}/`;
const chrome = spawn(chromium.executablePath(), ['--headless', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const chromeExited = once(chrome, 'exit');
const endpoint = await new Promise((resolveReady, reject) => {
  let text = '';
  const timer = setTimeout(() => reject(new Error('Chrome startup timeout')), 15000);
  chrome.once('error', error => { clearTimeout(timer); reject(error); });
  chrome.stderr.on('data', chunk => {
    text += chunk.toString(); const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
    if (match?.[1]) { clearTimeout(timer); resolveReady(match[1]); }
  });
});
const browser = await chromium.connectOverCDP(z.string().parse(endpoint));
const page = browser.contexts()[0]?.pages()[0];
if (!page) throw new Error('Owned page missing');
const env = { ...process.env, FLASHACT_HOME: home };
const rows = [];
let foreground;
try {
  for (const mode of ['schedule', 'watch', 'arm']) {
    await page.goto(url);
    if (mode === 'schedule') await page.locator('#reserve').evaluate(button => { button.disabled = false; });
    const args = [cli, mode, '--backend', 'playwright', '--endpoint', endpoint, '--url', url, '--approved-url', url, '--selector', '#reserve', '--action', 'click'];
    if (mode !== 'watch') args.push('--at', new Date(Date.now() + 4000).toISOString());
    if (mode !== 'schedule') args.push('--when', 'enabled');
    foreground = spawn(process.execPath, args, { env });
    const exited = once(foreground, 'exit');
    const statuses = [];
    const jobId = await new Promise((resolveReady, reject) => {
      let buffer = ''; let diagnostics = '';
      const timer = setTimeout(() => reject(new Error(`CLI startup timeout: ${diagnostics}`)), 15000);
      foreground.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
      foreground.once('error', error => { clearTimeout(timer); reject(error); });
      foreground.once('exit', () => { clearTimeout(timer); reject(new Error(`CLI exited: ${diagnostics}`)); });
      foreground.stdout.on('data', chunk => {
        buffer += chunk.toString(); const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
        for (const line of lines) {
          const status = z.object({ jobId: z.string(), state: z.string() }).passthrough().parse(JSON.parse(line));
          statuses.push(status);
          if (status.state === 'ARMED' || status.state === 'WAITING') { clearTimeout(timer); resolveReady(status.jobId); }
        }
      });
    });
    if (mode !== 'schedule') await page.locator('#reserve').evaluate(button => { button.disabled = false; });
    await page.waitForFunction('window.clicks === 1', undefined, { timeout: 15000 });
    const result = JSON.parse((await exec(process.execPath, [cli, 'status', jobId], { env })).stdout);
    const cancel = JSON.parse((await exec(process.execPath, [cli, 'cancel', jobId], { env })).stdout);
    const clicks = await page.evaluate('window.clicks');
    if (result.state !== 'VERIFIED' || result.executions !== 1 || cancel.state !== 'VERIFIED' || clicks !== 1) throw new Error('CLI execution/cancellation contract failed');
    rows.push({ mode, statuses, result, cancelAfterDispatch: cancel, independentClicks: clicks });
    foreground.kill('SIGTERM'); await exited;
    if (foreground.exitCode !== 0) throw new Error('Foreground cleanup failed');
    foreground = undefined;
  }
  const client = new Client({ name: 'flashact-manual-qa', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--endpoint', endpoint], env, stderr: 'pipe' });
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    if (response.isError) throw new Error(`MCP operation failed: ${name}`);
    const content = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })) }).parse(response).content[0];
    if (!content) throw new Error('MCP response has no content');
    return JSON.parse(content.text);
  };
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    if (tools.length !== 10) throw new Error('MCP tool inventory mismatch');
    const tabs = z.array(z.object({ id: z.string(), url: z.string() })).parse(await call('flashact_list_tabs', { backend: 'playwright' }));
    const tab = tabs.find(candidate => candidate.url === url);
    if (!tab) throw new Error('MCP existing tab unavailable');
    const inspected = await call('flashact_inspect_target', { backend: 'playwright', tabId: tab.id, selector: '#reserve' });
    const plan = { schemaVersion: '1.0', jobId: 'manual-mcp', name: 'Existing local tab', backend: 'playwright',
      target: { tabId: tab.id, selector: '#reserve', url }, trigger: { type: 'ELEMENT_ENABLE', selector: '#reserve' },
      action: { type: 'click' }, timezone: 'UTC', expiresAt: Date.now() + 60000, maxExecutions: 1,
      verification: { timeoutMs: 1000 }, guards: { approvedUrl: url, allowIrreversible: false } };
    await call('flashact_create_job', { plan }); await call('flashact_validate_job', { jobId: plan.jobId });
    await call('flashact_arm_job', { jobId: plan.jobId });
    await page.waitForFunction('window.clicks === 2', undefined, { timeout: 15000 });
    const result = await call('flashact_get_result', { jobId: plan.jobId });
    await page.locator('#reserve').evaluate(button => { button.disabled = true; });
    const pending = { ...plan, jobId: 'manual-mcp-pending' };
    await call('flashact_create_job', { plan: pending }); await call('flashact_validate_job', { jobId: pending.jobId });
    await call('flashact_arm_job', { jobId: pending.jobId });
    const waiting = await call('flashact_get_status', { jobId: pending.jobId });
    const cancelled = await call('flashact_cancel_job', { jobId: pending.jobId });
    const independentClicks = await page.evaluate('window.clicks');
    if (result.state !== 'VERIFIED' || result.executions !== 1 || waiting.state !== 'WAITING' || cancelled.state !== 'CANCELLED' || cancelled.executions !== 0 || independentClicks !== 2) throw new Error('MCP execution/cancellation contract failed');
    rows.push({ mode: 'mcp', tools, inspected, result, waiting, cancelled, independentClicks, existingTabAlive: !page.isClosed() });
  } finally { await client.close(); await transport.close(); }
  await page.screenshot({ path: 'artifacts/qa/manual-cli.png' });
} finally {
  if (foreground && foreground.exitCode === null && foreground.signalCode === null) { const exited = once(foreground, 'exit'); foreground.kill('SIGTERM'); await exited; }
  await browser.close(); chrome.kill('SIGTERM'); await chromeExited;
  await new Promise((resolveClosed, reject) => { fixture.close(error => error ? reject(error) : resolveClosed()); fixture.closeAllConnections(); });
  await rm(home, { recursive: true }); await rm(profile, { recursive: true });
}
await mkdir('artifacts/qa', { recursive: true });
const report = { cli, rows, teardown: ['Foreground CLI children exited 0', 'MCP client and stdio child closed', 'CDP client detached and owned Chrome exited', 'Fixture listener closed', 'Private IPC home and browser profile removed'] };
await writeFile('artifacts/qa/manual-cli.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
