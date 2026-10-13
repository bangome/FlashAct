import { serveFixture } from '../dist/benchmark/fixture.js';
const fixture = await serveFixture(Number(process.argv[2] ?? 0));
console.log(JSON.stringify({ url: fixture.url, pid: process.pid }));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { await fixture.close(); process.exit(0); });
}
