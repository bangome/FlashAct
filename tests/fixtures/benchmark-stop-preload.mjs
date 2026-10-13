// Faults stay at the public adapter boundary; production has no test flags/hooks.
import { chromium } from 'playwright';
import { installStopProbe } from './benchmark-stop-fake.mjs';

installStopProbe();

const mode = process.env.FLASHACT_STOP_FAULT;
const send = value => { if (process.connected) process.send(value); };
process.channel?.unref();
const launch = chromium.launch.bind(chromium);
chromium.launch = async options => {
  const browser = await launch(options);
  send({ event: 'browser-created', version: browser.version(), options });
  browser.on('disconnected', () => send({ event: 'browser-disconnected' }));
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async options => {
    send({ event: 'new-context' });
    const context = await newContext(options);
    context.on('close', () => send({ event: 'context-closed' }));
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      page.on('close', () => send({ event: 'page-closed' }));
      if (mode === 'sigint-evaluate' || mode === 'watchdog-evaluate') {
        await page.exposeFunction('__benchmarkStopStarted', () => send({ event: 'evaluate-pending' }));
        const evaluate = page.evaluate.bind(page);
        page.evaluate = async (expression, argument) => {
          if (typeof expression !== 'string' || !expression.startsWith('(async function visibleTrial')) {
            return evaluate(expression, argument);
          }
          try {
            return await evaluate(() => { globalThis.__benchmarkStopStarted(); return new Promise(() => {}); });
          } finally { send({ event: 'evaluate-settled' }); }
        };
      }
      return page;
    };
    return context;
  };
  if (mode === 'sigint-launch') {
    await new Promise(resolve => {
      const signalObserved = () => queueMicrotask(() => send({ event: 'signal-observed' }));
      process.once('SIGINT', signalObserved);
      process.once('message', message => {
        process.removeListener('SIGINT', signalObserved);
        if (message === 'release-launch') resolve();
      });
      send({ event: 'launch-pending' });
    });
    send({ event: 'launch-returned' });
  }
  return browser;
};
