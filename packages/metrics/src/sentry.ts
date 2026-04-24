// dot.li — Centralized Sentry initialization
//
// Kept in its own module so `@dotli/metrics/metrics` stays free of a hard
// `@sentry/browser` import — callers that only need the `m` API (spans,
// counters, distributions) still get a Sentry-less bundle.
//
// Call once from the entry point of an app or Worker:
//
//   import { initSentry } from "@dotli/metrics/sentry";
//   initSentry("host");

import * as Sentry from "@sentry/browser";
import { bindLogSink, log, type LogLevel } from "@dotli/shared/log";
import { serializeError, fullErrorChain } from "@dotli/shared/errors";
import { m } from "./metrics";

/**
 * Logical source of a Sentry event. All surfaces report to a single Sentry
 * project ("dotli"); this value drives the `source` tag so events from host,
 * worker and sandbox stay distinguishable inside that single project.
 */
export type SentryProject = "host" | "worker" | "sandbox";

/**
 * Initialize Sentry with the dot.li-standard config for the given source
 * and bind it to `@dotli/metrics` so spans/counters flow through. Safe to
 * call unconditionally — when the DSN env var is unset, Sentry becomes a
 * no-op, but we warn loudly instead of silently disabling reporting.
 */
export function initSentry(project: SentryProject): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  const env =
    (import.meta.env.VITE_APP_ENV as string | undefined) ?? "development";
  Sentry.init({
    dsn,
    tunnel: "/t",
    environment: env,
    release: import.meta.env.VITE_COMMIT_SHA as string | undefined,
    sendDefaultPii: false,
  });
  m.bind(Sentry as unknown as Parameters<typeof m.bind>[0]);
  // Use the canonical schema keys documented in `metrics.ts` (`source`,
  // `env`). The metrics layer owns any Sentry-side prefixing, so we pass
  // bare keys here — previously we used `dotli_source` / `dotli_env`,
  // which became `dotli.dotli_source` / `dotli.dotli_env` after the
  // mirroring layer's prefix, drifting away from the documented schema.
  m.setDefaults({ source: project, env });

  // If the DSN is missing in any non-development build, warn loudly once so
  // an operator doesn't lose hours wondering why the dashboard is empty.
  if ((dsn === undefined || dsn === "") && env !== "development") {
    console.warn(
      `[dot.li sentry] VITE_SENTRY_DSN missing in env "${env}" — error reporting is DISABLED.`,
    );
  }

  // Wire `log.warn` / `log.error` / `log.event` into Sentry breadcrumbs so
  // handled failures leave a trace in production regardless of `DEBUG`.
  // Inline lookups keep the sink resilient to lazy Sentry initialization.
  bindLogSink({
    emit: (
      level: LogLevel,
      message: string,
      attrs?: Record<string, unknown>,
      args?: unknown[],
    ) => {
      const sentryLevel: "info" | "warning" | "error" =
        level === "error" ? "error" : level === "warn" ? "warning" : "info";
      const data: Record<string, unknown> = { ...(attrs ?? {}) };
      if (args !== undefined && args.length > 0) {
        const errArg = args.find((a) => a instanceof Error);
        if (errArg !== undefined) {
          data.error = serializeError(errArg);
        }
      }
      Sentry.addBreadcrumb({
        category: "log",
        level: sentryLevel,
        message,
        data,
      });
    },
  });
}

/**
 * Catch otherwise-silent crashes and route them to Sentry.
 *
 * Behavior:
 *   - Pass the original `Error` through directly (don't wrap), so Sentry
 *     keeps the right stack/filename/lineno.
 *   - For non-Error throws, attach the raw value via `extra.rawThrown`
 *     so the original shape isn't lost behind a synthetic `Error`.
 *   - For `ErrorEvent`, capture `event.filename`/`lineno`/`colno` even when
 *     `event.error` is null (resource-load failures, CORS-tainted scripts).
 */
export function installGlobalErrorHandlers(source: SentryProject): void {
  if (typeof self === "undefined") {
    return;
  }

  self.addEventListener(
    "unhandledrejection",
    (event: PromiseRejectionEvent) => {
      const reason: unknown = event.reason;
      log.error(`[dot.li ${source}] unhandled rejection:`, reason);
      captureException(reason, {
        kind: "unhandledrejection",
        source,
      });
    },
  );

  self.addEventListener("error", (event: ErrorEvent) => {
    log.error(`[dot.li ${source}] window error:`, event.error ?? event.message);
    const tags: Record<string, string> = {
      kind: "window_error",
      source,
    };
    const extra: Record<string, unknown> = {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      message: event.message,
    };
    if (event.error instanceof Error) {
      Sentry.captureException(event.error, { tags, extra });
    } else {
      Sentry.captureException(
        new Error(event.message || "window error (no Error object)"),
        { tags, extra: { ...extra, rawError: event.error } },
      );
    }
  });
}

/**
 * Report a caught exception to Sentry. Preserves the original `Error`
 * instance (and its stack) when present; for non-Error throws, captures a
 * synthetic Error tagged with the structured chain plus the raw value.
 */
export function captureException(
  err: unknown,
  tags?: Record<string, string>,
): void {
  if (err instanceof Error) {
    Sentry.captureException(err, tags ? { tags } : undefined);
    return;
  }
  const chain = fullErrorChain(err);
  const synthetic = new Error(serializeError(err));
  synthetic.name = "NonErrorThrow";
  Sentry.captureException(synthetic, {
    tags,
    extra: {
      rawThrown: err,
      errorChain: chain,
    },
  });
}
