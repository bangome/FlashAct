import assert from 'node:assert/strict';
import { appendFileSync, realpathSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Package QA observation only: preserve the actual Worker and all its options.
const log = process.env.FLASHACT_QA_WORKER_AUDIT;
const expected = process.env.FLASHACT_QA_PACKAGE_ROOT;
assert(log && expected);
const require = createRequire(import.meta.url);
const threads = require('node:worker_threads');
const OriginalWorker = threads.Worker;
threads.Worker = class AuditedWorker extends OriginalWorker {
  constructor(url, options) {
    const address = url instanceof URL ? url.href : pathToFileURL(resolve(url)).href;
    const canonical = pathToFileURL(realpathSync(fileURLToPath(address))).href;
    assert(canonical.startsWith(pathToFileURL(`${realpathSync(expected)}/`).href), 'Package attempted a repository-coupled worker');
    appendFileSync(log, `${JSON.stringify({ url: address, canonical, parentPid: process.pid })}\n`);
    super(url, options);
  }
};
syncBuiltinESMExports();
