import type { TargetInfo } from "../core/types.js";
import type { FlashActErrorCode } from "../utils/errors.js";

/** Serialized independently: all browser dependencies must stay inside this factory. */
export function createDom() {
  class RuntimeError extends Error {
    constructor(readonly code: FlashActErrorCode, message: string) {
      super(message);
      this.name = "FlashActRuntimeError";
    }
  }
  function fail(code: FlashActErrorCode, message: string): never {
    throw new RuntimeError(code, message);
  }
  function unreachable(value: never): never {
    return fail("INTERNAL_ERROR", `Unexpected variant: ${String(value)}`);
  }
  function select(selector: string, root: ParentNode = document): readonly Element[] {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (error) {
      if (error instanceof DOMException) return fail("INVALID_PLAN", `Invalid CSS selector: ${selector}`);
      throw error;
    }
  }
  function enabled(element: Element): boolean {
    return !element.closest(':disabled, [aria-disabled="true"], [inert]');
  }
  function visible(element: Element): boolean {
    if (!element.isConnected || !Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0)) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0 || style.contentVisibility === "hidden") return false;
    }
    return true;
  }
  function irreversible(element: Element): boolean {
    const control = element.closest("button, input, a");
    if (control instanceof HTMLButtonElement) return control.form !== null && control.type === "submit";
    if (control instanceof HTMLInputElement) return control.form !== null && (control.type === "submit" || control.type === "image");
    if (control instanceof HTMLAnchorElement && control.hasAttribute("href")) {
      const destination = new URL(control.href, location.href);
      return control.hasAttribute("download") || destination.origin !== location.origin || !["http:", "https:"].includes(destination.protocol);
    }
    return false;
  }
  function inspect(selector: string): TargetInfo {
    const elements = select(selector);
    const element = elements.length === 1 ? elements[0] : undefined;
    return { selector, count: elements.length, enabled: element ? enabled(element) : false,
      visible: element ? visible(element) : false, url: location.href,
      irreversible: element ? irreversible(element) : false };
  }
  return { fail, unreachable, select, enabled, visible, irreversible, inspect,
    now: () => performance.timeOrigin + performance.now() };
}

export type RuntimeDom = ReturnType<typeof createDom>;
