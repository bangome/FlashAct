import type { Backend } from "../core/types.js";
import type { BrowserAdapter } from "./browser-adapter.js";
import type { AsideAdapterOptions } from "./aside/index.js";
import { AsideAdapter } from "./aside/index.js";
import { PlaywrightAdapter } from "./playwright/index.js";
import type { PlaywrightAdapterOptions } from "./playwright/index.js";
import { assertNever } from "../utils/errors.js";

export type AdapterFactoryOptions = PlaywrightAdapterOptions & AsideAdapterOptions;

export function createAdapter(backend: Backend, options: AdapterFactoryOptions = {}): BrowserAdapter {
  switch (backend) {
    case "playwright": return new PlaywrightAdapter(options);
    case "aside": return new AsideAdapter(options);
    default: return assertNever(backend);
  }
}
