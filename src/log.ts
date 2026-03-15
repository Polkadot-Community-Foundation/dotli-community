// dot.li — Debug logger
//
// Thin wrapper around console that respects the DEBUG flag.
// When DEBUG is false, all calls are no-ops.

import { DEBUG } from "./config";

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = (): void => {};

export const log = {
  warn: DEBUG ? console.warn.bind(console) : noop,
  error: DEBUG ? console.error.bind(console) : noop,
} as const;
