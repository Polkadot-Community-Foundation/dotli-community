// dot.li — Performance metrics for smoldot/protocol lifecycle
//
// Controlled via VITE_METRICS env var:
//   VITE_METRICS=true  → spans, measurements, and counters sent to Sentry
//   VITE_METRICS unset  → all calls are no-ops (zero overhead)
//
// Usage:
//   import { m } from "@dotli/metrics/metrics";
//   m.span("smoldot.relay_chain", async () => { await addChain(...) });
//   m.measure("smoldot.sync_duration", 2356);
//   m.count("protocol.mode", { mode: "shared_worker" });

interface MetricOptions {
  unit?: string;
  attributes?: Record<string, string>;
}

interface SentryLike {
  startSpan: <T>(
    opts: { op: string; name: string },
    fn: (span: unknown) => T,
  ) => T;
  setMeasurement: (name: string, value: number, unit: string) => void;
  metrics: {
    count: (name: string, value?: number, opts?: MetricOptions) => void;
    distribution: (name: string, value: number, opts?: MetricOptions) => void;
    gauge: (name: string, value: number, opts?: MetricOptions) => void;
  };
  setTag: (key: string, value: string) => void;
  addBreadcrumb: (breadcrumb: {
    category: string;
    message: string;
    level?: string;
    data?: Record<string, unknown>;
  }) => void;
}

// ── Sentry lazy binding ────────────────────────────────────────
// We resolve Sentry once at first use so the metrics package never
// forces a Sentry import. The host app must initialize Sentry before
// any metric calls fire.

let _sentry: SentryLike | null | undefined;

function sentry(): SentryLike | null {
  if (_sentry !== undefined) {
    return _sentry;
  }
  try {
    const hub = (globalThis as Record<string, unknown>).__SENTRY_HUB__;
    if (hub !== undefined && hub !== null) {
      _sentry = hub as SentryLike;
    } else {
      _sentry = null;
    }
  } catch {
    _sentry = null;
  }
  return _sentry;
}

/**
 * Bind a live Sentry instance. Call this from the app entry point
 * after `Sentry.init()` so the metrics package can record spans.
 *
 * ```ts
 * import * as Sentry from "@sentry/browser";
 * import { m } from "@dotli/metrics/metrics";
 * Sentry.init({ ... });
 * m.bind(Sentry);
 * ```
 */
function bind(s: SentryLike): void {
  _sentry = s;
}

// ── Enabled check ──────────────────────────────────────────────

const ENABLED = (import.meta.env.VITE_METRICS as string | undefined) === "true";

// ── Core API ───────────────────────────────────────────────────

/**
 * Wrap a sync or async function in a Sentry performance span.
 * When metrics are disabled, the function runs without instrumentation.
 */
function span<T>(name: string, fn: () => T): T;
function span<T>(name: string, fn: () => Promise<T>): Promise<T>;
function span<T>(name: string, fn: () => T | Promise<T>): T | Promise<T> {
  if (!ENABLED) {
    return fn();
  }
  const s = sentry();
  if (s === null) {
    return fn();
  }
  return s.startSpan({ op: "dotli", name: `dotli.${name}` }, () => fn());
}

/**
 * Record a numeric measurement on the current Sentry transaction.
 * Measurements appear in Sentry's performance dashboard.
 */
function measure(
  name: string,
  value: number,
  unit: "millisecond" | "second" | "byte" | "none" = "millisecond",
): void {
  if (!ENABLED) {
    return;
  }
  sentry()?.setMeasurement(`dotli.${name}`, value, unit);
}

/**
 * Increment a counter metric. Counters track event frequency.
 */
function count(name: string, attributes?: Record<string, string>): void {
  if (!ENABLED) {
    return;
  }
  sentry()?.metrics.count(`dotli.${name}`, 1, { attributes });
}

/**
 * Record a distribution (histogram) value. Use for latency distributions.
 */
function distribution(
  name: string,
  value: number,
  unit = "millisecond",
  attributes?: Record<string, string>,
): void {
  if (!ENABLED) {
    return;
  }
  sentry()?.metrics.distribution(`dotli.${name}`, value, {
    unit,
    attributes,
  });
}

/**
 * Record a gauge value (last-write-wins). Use for current state values.
 */
function gauge(
  name: string,
  value: number,
  unit = "none",
  attributes?: Record<string, string>,
): void {
  if (!ENABLED) {
    return;
  }
  sentry()?.metrics.gauge(`dotli.${name}`, value, { unit, attributes });
}

/**
 * Set a tag on the current Sentry scope. Tags are searchable in Sentry.
 */
function tag(key: string, value: string): void {
  if (!ENABLED) {
    return;
  }
  sentry()?.setTag(`dotli.${key}`, value);
}

/**
 * Add a breadcrumb for debugging context. Breadcrumbs appear in error reports.
 */
function breadcrumb(message: string, data?: Record<string, unknown>): void {
  if (!ENABLED) {
    return;
  }
  sentry()?.addBreadcrumb({
    category: "dotli",
    message,
    level: "info",
    data,
  });
}

/**
 * Start a manual timer. Returns a function that, when called,
 * records the elapsed duration as both a measurement and distribution.
 */
function timer(name: string): () => number {
  if (!ENABLED) {
    return () => 0;
  }
  const t0 = performance.now();
  return () => {
    const ms = performance.now() - t0;
    measure(name, ms);
    distribution(name, ms);
    return ms;
  };
}

// ── Public singleton ───────────────────────────────────────────

export const m = {
  /** Whether metrics collection is active */
  enabled: ENABLED,
  /** Bind a live Sentry instance after Sentry.init() */
  bind,
  /** Wrap a function in a performance span */
  span,
  /** Record a numeric measurement */
  measure,
  /** Increment a counter */
  count,
  /** Record a distribution (histogram) value */
  distribution,
  /** Record a gauge value */
  gauge,
  /** Set a searchable tag */
  tag,
  /** Add a debugging breadcrumb */
  breadcrumb,
  /** Start a manual timer, returns a stop function */
  timer,
} as const;
