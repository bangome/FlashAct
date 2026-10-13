// Persist implementation evidence even if a verification command or receipt lookup fails.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { hashes } from '../../scripts/visible-latency-report.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = new URL('../../artifacts/qa/benchmark-stop/', import.meta.url);
await mkdir(directory, { recursive: true });
const beforeReceipts = new Set(await readdir(directory));
const files = ['scripts/visible-latency-benchmark.mjs', 'scripts/visible-latency-runner.mjs',
  'scripts/visible-latency-owned.mjs', 'scripts/visible-latency-report.mjs',
  'tests/unit/visible-latency-stop.test.mjs', 'tests/e2e/visible-latency-stop.test.mjs',
  'tests/fixtures/benchmark-stop-red.mjs', 'tests/fixtures/benchmark-stop-fake.mjs',
  'tests/fixtures/benchmark-stop-preload.mjs', 'tests/fixtures/benchmark-stop-verify.mjs'];
const receipt = { status: 'IMPLEMENTED_PENDING_INDEPENDENT_REVIEW', startedAt: new Date().toISOString(), files,
  commands: [], red: [], green: [], measurements: {}, preservation: { before: await hashes() },
  lsp: 'Prior LSP installation refusal honored; Node --check for all changed MJS and project build/typecheck are the fallback.',
  decisions: ['Own and join native promises; no cancellation by Promise.race.',
    'Context.close is the closure owner of pages and CDP sessions; do not race redundant detach against native context closure.',
    'No post-stop evaluation for salvage; retain last host-observed evidence without claiming undo.',
    'Unique exclusively-created report files; old accepted evidence is rejected at output boundary.'],
  limitations: ['Unreachable native operations remain awaited; deadline emits SHUTDOWN_UNCONFIRMED, not a termination guarantee.',
    'Actual fault runs cover fresh local Chromium only, not remote connections or personal browser sessions.',
    'One real scheduled control trial, not a new 25-row timing audit. Existing accepted 25-row audit remains unchanged.',
    'No LSP server installation, independent approval, production-source changes, publication or commits.'] };
const commands = [
  ['npm', ['run', 'build']], ['npm', ['run', 'typecheck']],
  ...files.map(path => [process.execPath, ['--check', path]]),
  ['npx', ['vitest', 'run', 'tests/unit/visible-latency.test.mjs', 'tests/unit/visible-latency-stop.test.mjs', 'tests/e2e/visible-latency-stop.test.mjs']],
];
try {
  for (const file of files) {
    const text = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    const pureLOC = text.split('\n').filter(line => line.trim() && !/^\s*(\/\/|#|--)/.test(line)).length;
    receipt.measurements[file] = { pureLOC };
    if (pureLOC > 250) throw new Error(`Size limit exceeded: ${file}: ${pureLOC}`);
  }
  for (const [command, args] of commands) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; process.stdout.write(data); });
      child.stderr.on('data', data => { stderr += data; process.stderr.write(data); });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ command: [command, ...args], code, signal, stdout, stderr }));
    });
    receipt.commands.push(result);
    if (result.code !== 0) throw new Error(`Verification failed: ${command} ${args.join(' ')}`);
  }
  receipt.verification = 'PASS';
} catch (error) { receipt.verification = 'FAIL'; receipt.error = String(error); process.exitCode = 1; }
finally {
  try {
    const names = await readdir(directory);
    for (const name of names) {
      if (name.startsWith('red-')) {
        const red = JSON.parse(await readFile(new URL(name, directory), 'utf8'));
        receipt.red.push({ path: name, command: red.command, receipts: red.receipts, cleanup: red.cleanup });
      } else if (!beforeReceipts.has(name) && name.endsWith('-receipt.json')) {
        const green = JSON.parse(await readFile(new URL(name, directory), 'utf8'));
        receipt.green.push({ path: name, mode: green.mode, reportPath: green.reportPath, assertions: green.assertions,
          cleanup: green.cleanup, exit: green.exit, reportStatus: green.reportStatus });
      }
    }
    receipt.preservation.after = await hashes();
    receipt.preservation.unchanged = JSON.stringify(receipt.preservation.before) === JSON.stringify(receipt.preservation.after);
    receipt.cleanup = { ownedResources: receipt.green.map(result => result.cleanup),
      temporaryDirectories: 'Unit and RED sandbox directories removed in finally; native Chromium profiles owned by public launch/close.',
      receiptsRetained: 'Unique per-run artifacts, including failed development attempts; no overwrites.' };
    if (!receipt.preservation.unchanged || receipt.green.length !== 4 || receipt.green.some(result => result.assertions !== 'PASS')) {
      receipt.verification = 'FAIL'; process.exitCode = 1;
    }
  } catch (error) { receipt.receiptLookupError = String(error); receipt.verification = 'INCOMPLETE'; process.exitCode = 1; }
  receipt.finishedAt = new Date().toISOString();
  const path = new URL(`implementation-${randomUUID()}.json`, directory);
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ implementationReceipt: fileURLToPath(path), verification: receipt.verification }));
}
