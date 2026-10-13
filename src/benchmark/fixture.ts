import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { FlashActError } from '../utils/errors.js';

export async function serveFixture(port = 0): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> {
  const html = await readFile(new URL('../../examples/local.html', import.meta.url));
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname !== '/local.html' && pathname !== '/') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
  });
  await new Promise<void>((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveReady);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new FlashActError('INTERNAL_ERROR', 'Fixture has no TCP address');
  }
  return {
    url: `http://127.0.0.1:${address.port}/local.html`,
    close: () => new Promise<void>((resolveClosed, reject) => {
      server.close((error) => error ? reject(error) : resolveClosed());
      server.closeAllConnections();
    }),
  };
}
