import { parentPort } from 'node:worker_threads';
import { chromium } from 'playwright';

const resources = {};

async function connect(endpoint, options) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Owned CDP socket failed to open')), { once: true });
  });
  const record = (direction, message) => parentPort.postMessage({
    type: 'protocol',
    record: { direction, at: new Date().toISOString(), ...message },
  });
  const transport = {
    send(message) { record('send', message); socket.send(JSON.stringify(message)); },
    close() { socket.close(); },
  };
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    record('receive', message);
    transport.onmessage?.(message);
  });
  socket.addEventListener('close', () => {
    record('close', {});
    transport.onclose?.();
  });
  resources.browser = await chromium.connectOverCDP(transport, options);
}

async function invoke(command, args) {
  switch (command) {
    case 'attach': return await connect(...args);
    case 'contexts': {
      const contexts = resources.browser.contexts();
      resources.context = contexts[0];
      return contexts.length;
    }
    case 'browser-session':
      resources.browserCDP = await resources.browser.newBrowserCDPSession();
      return;
    case 'page':
      resources.page = await resources.context.newPage();
      return;
    case 'page-session':
      resources.pageCDP = await resources.context.newCDPSession(resources.page);
      return;
    case 'send': return await resources[args[0]].send(args[1], args[2]);
    case 'evaluate': return await resources.page.evaluate(args[0]);
    case 'init':
      await resources.page.addInitScript(args[0]);
      return;
    case 'goto': return await resources.page.goto(...args).then(() => undefined);
    case 'url': return resources.page.url();
    case 'front':
      await resources.page.bringToFront();
      return;
    case 'close': {
      const name = args[0], resource = resources[name];
      if (name === 'pageCDP' || name === 'browserCDP') await resource.detach();
      else if (name === 'page') await resource.close({ runBeforeUnload: false });
      else await resource.close();
      delete resources[name];
      return;
    }
    default: throw new Error(`Unknown probe driver command: ${command}`);
  }
}

parentPort.on('message', async ({ id, command, args }) => {
  try { parentPort.postMessage({ id, value: await invoke(command, args) }); }
  catch (error) { parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
});
