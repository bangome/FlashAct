import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createContext, runInContext } from 'node:vm';
import { createServer } from 'node:http';
import { rename, writeFile } from 'node:fs/promises';

const mode = process.argv[2];
const startedPath = process.argv[3];
const keepAlive = createServer();
await new Promise(resolve => keepAlive.listen(0, '127.0.0.1', resolve));
if (mode === 'ignore-term') process.on('SIGTERM', () => undefined);
process.stdin.once('end', () => { if (mode !== 'ignore-term') keepAlive.close(); });
const browser = createContext({});
const target = {
  async evaluate(expression) {
    if (expression === '__hold__') {
      await writeFile(startedPath + '.tmp', JSON.stringify({ pid: process.pid }));
      await rename(startedPath + '.tmp', startedPath);
      return new Promise(() => {});
    }
    return runInContext(expression, browser);
  },
};
let logs = [];
const scope = createContext({
  getTabByTargetId: () => target,
  attachBrowserTab: async () => target,
  console: { log: value => logs.push(String(value)) },
});
const server = new Server({ name: 'aside-fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'repl', inputSchema: { type: 'object', properties: {
    title: { type: 'string' }, code: { type: 'string' },
  }, required: ['title', 'code'] } }],
}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (request.params.name !== 'repl' || typeof request.params.arguments?.code !== 'string')
    throw new Error('Invalid fixture request');
  logs = [];
  await runInContext(`(async () => { ${request.params.arguments.code} })()`, scope);
  return { content: [{ type: 'text', text: logs.join('\n') }], isError: false };
});
await server.connect(new StdioServerTransport());
