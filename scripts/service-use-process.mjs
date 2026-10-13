import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

export function stdioMcpClient(process) {
  let nextId = 0;
  const request = async (method, params) => {
    const id = ++nextId;
    const reply = process.waitFor(value => value.id === id, `actual MCP ${method}`);
    process.send({ jsonrpc: '2.0', id, method, params });
    const response = await reply;
    assert(!response.error, JSON.stringify(response));
    return response.result;
  };
  return {
    initialize: async () => {
      await request('initialize', { protocolVersion: '2025-11-25', capabilities: {},
        clientInfo: { name: 'actual-service-use', version: '1' } });
      process.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    tool: async (name, args) => {
      const result = await request('tools/call', { name, arguments: args });
      assert(!result.isError, JSON.stringify(result));
      assert.equal(result.content[0]?.type, 'text');
      return JSON.parse(result.content[0].text);
    },
  };
}

/** Actual stdout/close barriers; a missing state stops and joins its producer. */
export function recordedProcess(command, args, env, record, cwd) {
  const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  record.cwd = cwd;
  record.command = command; record.args = args; record.pid = child.pid;
  record.stdout = ''; record.stderr = ''; record.messages = [];
  let buffer = '', stopping, ended = false, protocolError;
  const listeners = new Set();
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      ended = true; record.exit = { code, signal };
      for (const listener of listeners) listener(undefined);
      resolve(record.exit);
    });
  });
  const stop = (signal = 'SIGTERM') => {
    stopping ??= (async () => {
      let forced = false;
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          forced = true; child.kill('SIGKILL');
        }
      }, 10000);
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        const receipt = await exited;
        record.forced = forced;
        if (forced) throw new Error('Recorded child required force exit; graceful cleanup is unconfirmed');
        return receipt;
      } finally { clearTimeout(timer); }
    })();
    return stopping;
  };
  child.stderr.on('data', chunk => { record.stderr += chunk.toString(); });
  child.stdout.on('data', chunk => {
    record.stdout += chunk.toString(); buffer += chunk.toString();
    const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      let value;
      try { value = JSON.parse(line); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        protocolError = new Error('Actual child emitted non-JSON stdout');
        for (const listener of listeners) listener(undefined);
        void stop();
        return;
      }
      record.messages.push(value);
      for (const listener of listeners) listener(value);
    }
  });
  return {
    child, exited, stop,
    send: value => child.stdin.write(`${JSON.stringify(value)}\n`),
    end: () => child.stdin.end(),
    waitFor(predicate, label, timeoutMs = 20000) {
      if (protocolError) return Promise.reject(protocolError);
      const existing = record.messages.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      if (ended) return Promise.reject(new Error(`Actual child exited before ${label}`));
      return new Promise((resolve, reject) => {
        const listener = value => {
          if (value === undefined) { finish(protocolError ?? new Error(`Actual child exited before ${label}`)); return; }
          if (predicate(value)) finish(undefined, value);
        };
        const finish = (error, value) => {
          clearTimeout(timer); listeners.delete(listener);
          if (error) reject(error); else resolve(value);
        };
        const timer = setTimeout(() => {
          void stop().then(() => finish(new Error(`Missing ${label} after joined actual child exit`)), finish);
        }, timeoutMs);
        listeners.add(listener);
      });
    },
  };
}
