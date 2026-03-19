// dot.li — Debug logger
//
// Thin wrapper around console that respects the DEBUG flag.
// When DEBUG is false, all calls are no-ops.

import { DEBUG } from "@dotli/config/config";

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = (): void => {};

export const log = {
  // eslint-disable-next-line no-console -- intentional: logger module binds console methods
  debug: DEBUG ? console.debug.bind(console) : noop,
  // eslint-disable-next-line no-console -- intentional: logger module binds console methods
  info: DEBUG ? console.info.bind(console) : noop,
  warn: DEBUG ? console.warn.bind(console) : noop,
  error: DEBUG ? console.error.bind(console) : noop,
} as const;
