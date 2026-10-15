import type { ExecutionPlan } from "../core/types.js";
import { createDom } from "../runtime/dom.js";
import type { CaptureRegion } from "./types.js";

type View = {
  readonly state: "waiting" | "ready" | "filled" | "submitted" | "verified" | "invalid" | "timeout" | "cancelled" | "unknown";
  readonly inputs: number;
  readonly submissions: number;
  readonly region?: CaptureRegion;
};
type Bridge = { read(leaseMs: number): Promise<View>; fill(text: string): View; cancel(): View };
declare global {
  var __flashactCaptchas: Map<string, Bridge> | undefined;
}

/** Serialized with its dependencies; cached nodes never get replaced by selector re-resolution. */
function install(key: string, plan: ExecutionPlan, makeDom: typeof createDom): boolean {
  if (!plan.captcha) return false;
  const config = plan.captcha;
  const dom = makeDom();
  const originalTarget = dom.select(plan.target.selector)[0];
  const documentAtInstall = document;
  let challengeScreen: Element | undefined;
  let image: Element | undefined;
  let input: HTMLInputElement | undefined;
  let submit: HTMLElement | undefined;
  let source = "";
  let imageVersion = 0;
  let readyLoadEvent: Event | undefined;
  const initialLoads = new WeakSet<HTMLImageElement>();
  const loaded = (event: Event) => {
    if (event.target instanceof HTMLImageElement && initialLoads.has(event.target)) {
      if (event.target === image) readyLoadEvent = event;
      initialLoads.delete(event.target);
    }
  };
  const imageLoaded = (event: Event) => { if (event !== readyLoadEvent) imageVersion++; };
  let inputs = 0;
  let submissions = 0;
  let cancelled = false;
  let unknown = false;
  let readyRegion: CaptureRegion | undefined;
  let deadline: number | undefined;
  const readers = new Set<() => void>();
  const registry = globalThis.__flashactCaptchas ??= new Map();
  if (registry.has(key)) return false;
  const imageSource = (element: Element) => element instanceof HTMLImageElement
    ? `${element.currentSrc}|${element.src}|${element.naturalWidth}|${element.naturalHeight}|${imageVersion}`
    : element instanceof HTMLCanvasElement ? element.toDataURL("image/png") : element.getAttribute("style") ?? "";
  function view(state: View["state"], region?: CaptureRegion): View {
    return { state, inputs, submissions, ...(region ? { region } : {}) };
  }
  function repeatsOriginal(candidate: Element): boolean {
    const controls = (element: Element): ReadonlySet<Element> => {
      const actionable = new Set<Element>();
      const visited = new Set<Element>();
      function collect(start: Element): void {
        for (let node: Element | null = start; node && !visited.has(node); node = node.parentElement) {
          visited.add(node);
          if (node.matches('button,input,a,[role="button"],[role="link"]')) actionable.add(node);
          if (node instanceof HTMLLabelElement && node.control) collect(node.control);
        }
      }
      collect(element);
      return actionable;
    };
    const candidateControls = controls(candidate);
    return [originalTarget, ...dom.select(plan.target.selector)].some(original =>
      original !== undefined && (original.contains(candidate) || candidate.contains(original)
        || [...controls(original)].some(control => candidateControls.has(control))));
  }
  function guarded(): boolean {
    if (cancelled || document !== documentAtInstall || location.href !== plan.guards.approvedUrl) return false;
    const original = globalThis.__flashactRuntime?.status(plan.jobId);
    if (original === undefined || original.executions !== 1
      || (original.state !== "DISPATCHED" && original.state !== "VERIFIED")) return false;
    if (!challengeScreen || !image || !input || !dom.visible(challengeScreen) || !dom.enabled(challengeScreen)
      || !challengeScreen.contains(image) || !challengeScreen.contains(input)
      || (submit && !challengeScreen.contains(submit))) return false;
    for (const [selector, cached] of [[config.screenSelector, challengeScreen],
      [config.imageSelector, image], [config.inputSelector, input],
      [config.submitSelector, submit]] as const) {
      if (selector && cached) {
        const current = dom.select(selector);
        if (current.length !== 1 || current[0] !== cached || !cached.isConnected) return false;
      }
    }
    return (!submit || !repeatsOriginal(submit)) && (!image || source === imageSource(image));
  }
  function readNow(event?: Event): View {
    if (cancelled) return view("cancelled");
    if (unknown) return view("unknown");
    if (document !== documentAtInstall || location.href !== plan.guards.approvedUrl) return view("invalid");
    if (!image) {
      const pendingImage = dom.select(config.imageSelector)[0];
      if (pendingImage instanceof HTMLImageElement && !pendingImage.complete) initialLoads.add(pendingImage);
    }
    const original = globalThis.__flashactRuntime?.status(plan.jobId);
    if (!original) return view("invalid");
    if (["CANCELLED", "UNKNOWN", "FAILED", "INVALIDATED", "EXPIRED"].includes(original.state)) return view("invalid");
    if (original.executions === 0) return view("waiting");
    if (inputs > 0 && config.successSelector) {
      const successes = dom.select(config.successSelector);
      if (successes.length === 1 && successes[0] && dom.visible(successes[0])) return view("verified");
    }
    if (inputs > 0 && !config.successSelector) return view("filled");
    if (Date.now() >= (deadline ?? plan.expiresAt)) return view("timeout");
    if (inputs > 0) return view(submissions ? "submitted" : "filled");
    const screens = dom.select(config.screenSelector);
    if (screens.length > 1) return view("invalid");
    const nextScreen = screens[0];
    if (challengeScreen && challengeScreen !== nextScreen) return view("invalid");
    if (!nextScreen || !dom.visible(nextScreen) || !dom.enabled(nextScreen))
      return view(challengeScreen ? "invalid" : "waiting");
    if (nextScreen === document.body || nextScreen === document.documentElement) return view("invalid");
    const images = dom.select(config.imageSelector);
    const fields = dom.select(config.inputSelector);
    if (images.length > 1 || fields.length > 1) return view("invalid");
    const nextImage = images[0];
    const nextInput = fields[0];
    if ((image && image !== nextImage) || (input && input !== nextInput)) return view("invalid");
    if (!nextImage || !nextInput || !dom.visible(nextImage) || !dom.visible(nextInput)
      || !dom.enabled(nextInput)) return view("waiting");
    if (!nextScreen.contains(nextImage) || !nextScreen.contains(nextInput)) return view(challengeScreen ? "invalid" : "waiting");
    if (!(nextInput instanceof HTMLInputElement) || !["text", "search", "tel"].includes(nextInput.type)
      || nextInput.readOnly || nextInput.value !== "") return view("invalid");
    if (nextImage instanceof HTMLImageElement && (!nextImage.complete || nextImage.naturalWidth === 0)) return view("waiting");
    const controls = config.submitSelector ? dom.select(config.submitSelector) : [];
    if (config.submitSelector && controls.length > 1) return view("invalid");
    const nextSubmit = controls[0];
    if (nextSubmit && repeatsOriginal(nextSubmit)) return view("invalid");
    if (submit && submit !== nextSubmit) return view("invalid");
    if (config.submitSelector && (!(nextSubmit instanceof HTMLElement) || !dom.visible(nextSubmit)
      || !dom.enabled(nextSubmit))) return view("waiting");
    if (nextSubmit && !nextScreen.contains(nextSubmit)) return view(challengeScreen ? "invalid" : "waiting");
    if (nextSubmit && !plan.guards.allowIrreversible && dom.irreversible(nextSubmit)) return view("invalid");
    if (config.successSelector && dom.select(config.successSelector).length > 0) return view("invalid");
    const box = nextImage.getBoundingClientRect();
    const region = { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height };
    if (region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0
      || region.width > 2048 || region.height > 2048) return view("invalid");
    const currentSource = imageSource(nextImage);
    if (image && (source !== currentSource || JSON.stringify(readyRegion) !== JSON.stringify(region))) return view("invalid");
    if (!image) {
      // A capturing document listener can bind during this very load dispatch.
      // Do not mistake its later target phase for a second image load.
      readyLoadEvent = event?.type === "load" && event.target === nextImage ? event : undefined;
      nextImage.addEventListener("load", imageLoaded);
    }
    challengeScreen = nextScreen; image = nextImage; input = nextInput;
    if (nextSubmit instanceof HTMLElement) submit = nextSubmit;
    source = currentSource; readyRegion = region;
    deadline ??= Math.min(plan.expiresAt, Date.now() + config.timeoutMs);
    return view("ready", region);
  }
  function fill(text: string): View {
    if (!guarded() || readNow().state !== "ready" || !input) return view("invalid");
    const allowed = config.alphabet === "digits" ? /^[0-9]+$/ : config.alphabet === "uppercase-alphanumeric"
      ? /^[A-Z0-9]+$/ : /^[A-Za-z0-9]+$/;
    if (text.length !== config.length || !allowed.test(text)) return view("invalid");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) return view("invalid");
    // Claim before page handlers run. No repeated fill or submit is permitted.
    inputs = 1;
    try {
      setter.call(input, text);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      if (!guarded() || !input.isConnected || input.value !== text) { unknown = true; return view("unknown"); }
      input.dispatchEvent(new Event("change", { bubbles: true }));
      if (!guarded() || !input.isConnected || input.value !== text) { unknown = true; return view("unknown"); }
      if (config.successSelector && readNow().state === "verified") return view("verified");
      if (config.submitSelector) {
        if (!submit || repeatsOriginal(submit) || dom.select(config.submitSelector)[0] !== submit || !submit.isConnected
          || !dom.visible(submit) || !dom.enabled(submit)
          || (!plan.guards.allowIrreversible && dom.irreversible(submit))
          || !image?.isConnected || source !== imageSource(image)) { unknown = true; return view("unknown"); }
        submissions = 1;
        HTMLElement.prototype.click.call(submit);
      }
      return readNow();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      unknown = true; return view("unknown");
    }
  }
  const bridge: Bridge = {
    read: leaseMs => new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const observer = new MutationObserver(() => check());
      const resized = new ResizeObserver(() => check());
      function finish(result: View): void {
        if (settled) return;
        settled = true; clearTimeout(timer); observer.disconnect(); resized.disconnect();
        document.removeEventListener("__flashact_status__", check);
        document.removeEventListener("load", check, true);
        window.removeEventListener("pagehide", lost);
        readers.delete(check); resolve(result);
      }
      function check(event?: Event): void {
        const current = readNow(event);
        if (current.state !== "waiting" && current.state !== "submitted" && !(current.state === "filled" && config.successSelector))
          finish(current);
      }
      function lost(): void { finish(view("invalid")); }
      readers.add(check);
      observer.observe(document.documentElement, { subtree: true, attributes: true, childList: true, characterData: true });
      resized.observe(document.documentElement);
      document.addEventListener("__flashact_status__", check);
      document.addEventListener("load", check, true);
      window.addEventListener("pagehide", lost, { once: true });
      timer = setTimeout(() => finish(readNow()), leaseMs);
      check();
    }),
    fill,
    cancel: () => {
      cancelled = true;
      document.removeEventListener("load", loaded, true);
      image?.removeEventListener("load", imageLoaded);
      for (const check of [...readers]) check();
      registry.delete(key);
      return view(inputs || submissions ? "unknown" : "cancelled");
    },
  };
  document.addEventListener("load", loaded, true);
  registry.set(key, bridge);
  return true;
}

export function captchaInstallExpression(key: string, plan: ExecutionPlan): string {
  return `(${install.toString()})(${JSON.stringify(key)},${JSON.stringify(plan)},${createDom.toString()})`;
}
export function captchaReadExpression(key: string): string {
  return `globalThis.__flashactCaptchas?.get(${JSON.stringify(key)})?.read(1000)`;
}
export function captchaFillExpression(key: string, text: string): string {
  return `globalThis.__flashactCaptchas?.get(${JSON.stringify(key)})?.fill(${JSON.stringify(text)})`;
}
export function captchaCancelExpression(key: string): string {
  return `globalThis.__flashactCaptchas?.get(${JSON.stringify(key)})?.cancel()`;
}
