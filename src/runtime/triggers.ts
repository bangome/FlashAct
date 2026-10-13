import type { Trigger } from "../core/types.js";
import type { RuntimeDom } from "./dom.js";

/** Baselines belong to ARM, not INSTALL; state predicates never latch. */
export function createTriggers(trigger: Trigger, dom: RuntimeDom) {
  const roots = new Set<Node>();
  const scheduled: number[] = [];
  const appearances = new Set<string>();
  function compile(condition: Trigger): () => boolean {
    switch (condition.type) {
      case "AND": {
        const children = condition.conditions.map(compile);
        return () => children.every((test) => test());
      }
      case "OR": {
        const children = condition.conditions.map(compile);
        return () => children.some((test) => test());
      }
      case "SCHEDULED":
        scheduled.push(condition.at);
        return () => Date.now() >= condition.at && dom.now() >= condition.at;
      case "ELEMENT_APPEAR":
      case "ELEMENT_ENABLE":
      case "ELEMENT_VISIBLE":
      case "ATTRIBUTE_CHANGE":
      case "TEXT_CHANGE": {
        let element = dom.select(condition.selector)[0];
        roots.add(element?.parentElement ?? document.body ?? document.documentElement);
        let baseline: string | null = null;
        switch (condition.type) {
          case "ELEMENT_APPEAR": appearances.add(condition.selector); break;
          case "ATTRIBUTE_CHANGE": baseline = element?.getAttribute(condition.attribute) ?? null; break;
          case "TEXT_CHANGE": baseline = element?.textContent ?? null; break;
          case "ELEMENT_ENABLE": case "ELEMENT_VISIBLE": break;
          default: return dom.unreachable(condition);
        }
        return () => {
          if (!element?.isConnected || !element.matches(condition.selector)) element = dom.select(condition.selector)[0];
          if (!element) return false;
          switch (condition.type) {
            case "ELEMENT_APPEAR": return true;
            case "ELEMENT_ENABLE": return dom.enabled(element);
            case "ELEMENT_VISIBLE": return dom.visible(element);
            case "ATTRIBUTE_CHANGE": {
              const value = element.getAttribute(condition.attribute);
              return condition.value === undefined ? value !== baseline : value === condition.value;
            }
            case "TEXT_CHANGE": {
              const value = element.textContent;
              return condition.value === undefined ? value !== baseline : value === condition.value;
            }
            default: return dom.unreachable(condition);
          }
        };
      }
      default: return dom.unreachable(condition);
    }
  }
  const ready = compile(trigger);
  return { ready, roots, scheduled, appearances };
}

export type RuntimeTriggers = ReturnType<typeof createTriggers>;
