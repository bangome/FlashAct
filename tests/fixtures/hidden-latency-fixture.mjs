import { vi } from 'vitest';

// Measurement-only unit fixture. This does not emulate native browser visibility
// or prove compiled-runtime integration; trusted audit records are input data.
export function measurementFixture({ visible = false, audit = [], synchronous = false,
  terminal = false, missingClick = false, cancelFails = false } = {}) {
  const origin = 10000;
  vi.useFakeTimers();
  vi.setSystemTime(origin);
  const epoch = () => Date.now();
  const auditRecords = audit;
  const listeners = new Map();
  const setterRecords = [];
  const ledger = [{ jobId: 'previous-job', epochMs: origin - 1, wallMs: origin - 1, trusted: false }];
  let currentJobId, currentStatus, plan, runtimeTimer;

  class Button {
    #disabled = true;
    get disabled() { return this.#disabled; }
    set disabled(value) {
      this.#disabled = Boolean(value);
      if (value === false) {
        vi.setSystemTime(epoch() + 3);
        setterRecords.push({ value, epochMs: epoch() });
      }
    }
  }
  const button = new Button();
  class MeasurementDocument extends EventTarget {
    hidden = !visible;
    visibilityState = visible ? 'visible' : 'hidden';
    querySelector(selector) { return selector === '#reserve' ? button : null; }
    addEventListener(type, listener, options) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
      super.addEventListener(type, listener, options);
    }
    removeEventListener(type, listener, options) {
      listeners.get(type)?.delete(listener);
      super.removeEventListener(type, listener, options);
    }
  }
  const document = new MeasurementDocument();
  const status = (state, executions = 0, timing) => ({
    jobId: currentJobId, state, executions, updatedAt: epoch(),
    ...(timing ? { timing } : {}),
  });
  const click = () => {
    const event = new Event('click');
    Object.defineProperty(event, 'target', { value: button });
    document.dispatchEvent(event);
    // Faithfully finish the click task before hiddenTrial's await continuation.
    ledger.push({ jobId: currentJobId, epochMs: epoch(), wallMs: epoch(), trusted: event.isTrusted });
    currentStatus = status('VERIFIED', 1, { observerEpochMs: epoch(), clickEpochMs: epoch() });
  };
  const fixture = {
    ledger,
    reset: vi.fn((jobId, enabled) => {
      currentJobId = jobId;
      button.disabled = enabled ? false : true;
    }),
    enable: vi.fn(() => {
      button.disabled = false;
      if (!missingClick) runtimeTimer = setTimeout(click, 2);
    }),
  };
  const runtime = {
    documentId: 'measurement-document',
    install: vi.fn(value => {
      plan = value;
      currentStatus = status('INSTALLED');
      return currentStatus;
    }),
    arm: vi.fn(() => {
      currentStatus = status(terminal ? 'UNKNOWN' : 'ARMED');
      if (synchronous) click();
      else if (!terminal && !missingClick && plan.trigger.type === 'SCHEDULED') {
        runtimeTimer = setTimeout(click, plan.trigger.at - epoch());
      }
      return currentStatus;
    }),
    status: vi.fn(() => currentStatus),
    cancel: vi.fn(() => {
      clearTimeout(runtimeTimer);
      if (cancelFails) throw new Error('unit cancellation failure');
      return status('CANCELLED', currentStatus.executions);
    }),
  };
  vi.stubGlobal('document', document);
  vi.stubGlobal('HTMLButtonElement', Button);
  vi.stubGlobal('performance', { timeOrigin: origin, now: () => epoch() - origin });
  vi.stubGlobal('location', { href: 'http://measurement.test/fixture' });
  vi.stubGlobal('__flashactRuntime', runtime);
  vi.stubGlobal('__flashactFixture', fixture);
  vi.stubGlobal('__controlledVisibilityAudit', auditRecords);
  return {
    document, button, fixture, runtime, listeners, setterRecords, ledger, auditRecords,
    interrupt() {
      document.hidden = false;
      document.visibilityState = 'visible';
      auditRecords.push({ kind: 'visibilitychange', isTrusted: true,
        hidden: false, visibilityState: 'visible', epochMs: epoch(), wallMs: epoch() });
      document.dispatchEvent(new Event('visibilitychange'));
    },
  };
}
