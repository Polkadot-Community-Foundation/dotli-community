// Prod no-op shim for `@sentry/browser`, aliased in
// `apps/*/vite.config.ts`. Only mirrors what app/package code calls
// directly — `sentry.ts`'s internal calls are unreachable because that
// file is itself aliased to `sentry.noop.ts` in prod.

const noop = (): void => {
  /* no-op */
};

export const init = noop;
export const captureException = noop;
export const captureMessage = noop;
export const setUser = noop;
export const setTag = noop;
export const addBreadcrumb = noop;
export const setMeasurement = noop;

export function startSpan<T>(
  _opts: { op: string; name: string },
  fn: (
    span: { setAttribute: (key: string, value: string) => void } | undefined,
  ) => T,
): T {
  return fn(undefined);
}

export function browserTracingIntegration(_opts?: unknown): unknown {
  return undefined;
}

export const metrics = {
  count: noop,
  distribution: noop,
  gauge: noop,
} as const;
