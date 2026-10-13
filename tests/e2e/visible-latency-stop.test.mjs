import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidenceDirectory = new URL('../../artifacts/qa/benchmark-stop/', import.meta.url);

describe('real public Node CLI cooperative shutdown', () => {
  it.each(['sigint-launch', 'sigint-evaluate', 'watchdog-evaluate', 'control'])('joins and closes owned Chromium for %s', async mode => {
    // Given: unique evidence, a fresh launched browser, an ephemeral fixture, IPC stage handshake.
    await mkdir(evidenceDirectory, { recursive: true });
    const id = `${mode}-${randomUUID()}`;
    const output = fileURLToPath(new URL(`${id}.json`, evidenceDirectory));
    const args = ['--control', '--output', output, '--watchdog-ms', mode === 'watchdog-evaluate' ? '3500' : '30000'];
    const execArgv = ['--import', fileURLToPath(new URL('../fixtures/benchmark-stop-preload.mjs', import.meta.url))];
    const child = fork('scripts/visible-latency-benchmark.mjs', args, { cwd: root, execArgv,
      env: { ...process.env, FLASHACT_STOP_FAULT: mode }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const events = [];
    let stdout = '', stderr = '', forced = false;
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const emergency = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 25000);
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.on('message', message => {
      events.push(message);
      // When: SIGINT is sent only after an actual native resource/operation exists.
      if (message.event === 'launch-pending' || (mode === 'sigint-evaluate' && message.event === 'evaluate-pending')) child.kill('SIGINT');
      if (message.event === 'signal-observed') child.send('release-launch');
    });
    let receipt;
    try {
      const exit = await exited;
      const bytes = await readFile(output, 'utf8');
      const report = JSON.parse(bytes);
      receipt = { command: [process.execPath, ...execArgv, 'scripts/visible-latency-benchmark.mjs', ...args],
        mode, exit, forced, events, stdout, stderr, reportPath: output, reportStatus: report.status,
        finalSha256: createHash('sha256').update(bytes).digest('hex'),
        cleanup: { ...report.teardown, cleanupSuccess: report.cleanupSuccess, pending: report.lifecycle.pending },
        stableWriteProof: 'Read after child close (stdio and IPC closed): producer process has exited, no subsequent writes possible.',
        stopReason: report.lifecycle.stopReason, preserved: report.hashManifest.unchanged, assertions: 'pending' };
      // Then: native close events plus normal process exit, drained report, one stdout summary.
      expect(forced).toBe(false);
      expect(exit).toEqual({ code: mode === 'control' ? 0 : 1, signal: null });
      expect(stderr).toBe('');
      expect(stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(stdout)).toMatchObject({ status: report.status, output, cleanupSuccess: true });
      expect(report).toMatchObject({ cleanupSuccess: true, hashManifest: { unchanged: true }, lifecycle: { pending: [] } });
      expect(events.filter(event => event.event === 'browser-disconnected')).toHaveLength(1);
      expect(report.launchOptions).toMatchObject({ timeout: 15000, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
      if (mode === 'sigint-launch') {
        expect(events.some(event => event.event === 'new-context')).toBe(false);
        expect(report.completedVisibleTrials).toBe(0);
        expect(report.lifecycle.stopReason).toBe('SIGINT');
      } else {
        expect(events.filter(event => event.event === 'context-closed')).toHaveLength(1);
        expect(events.filter(event => event.event === 'page-closed')).toHaveLength(1);
        if (mode === 'control') {
          expect(report.status).toBe('VISIBLE VERIFIED');
          expect(report.samples).toHaveLength(1);
          expect(report.samples[0]).toMatchObject({ success: true, status: { state: 'VERIFIED', executions: 1 } });
          expect(report.samples[0].clicks).toHaveLength(1);
          expect(report.samples[0].clicks[0].trusted).toBe(false);
        } else {
          expect(events.filter(event => event.event === 'evaluate-pending')).toHaveLength(1);
          expect(events.filter(event => event.event === 'evaluate-settled')).toHaveLength(1);
          expect(report.completedVisibleTrials).toBe(0);
          expect(report.samples).toHaveLength(1);
          expect(report.samples[0]).toMatchObject({ aborted: true, success: false, evidence: 'no-host-observation' });
          expect(report.lifecycle.stopReason).toBe(mode === 'watchdog-evaluate' ? 'watchdog' : 'SIGINT');
          const closeStart = report.lifecycle.events.findIndex(event => event.event === 'close-start' && event.name === 'context');
          const settled = report.lifecycle.events.findIndex(event => event.event === 'settled' && event.name === 'trial');
          expect(closeStart).toBeLessThan(settled);
        }
      }
      const stop = report.lifecycle.events.findIndex(event => event.event === 'stop');
      if (stop >= 0) expect(report.lifecycle.events.slice(stop + 1).filter(event => event.event === 'start')).toEqual([]);
      receipt.assertions = 'PASS';
    } catch (error) {
      receipt = { ...receipt, mode, events, stdout, stderr, forced, assertions: 'FAIL', error: String(error), output };
      throw error;
    } finally {
      clearTimeout(emergency);
      await writeFile(new URL(`${id}-receipt.json`, evidenceDirectory), `${JSON.stringify(receipt, null, 2)}\n`);
    }
  }, 30000);
});
