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
import { m } from "./metrics";

/**
 * Logical Sentry project name.
 * Maps 1-to-1 to `VITE_SENTRY_DSN_<PROJECT>` + a distinct tunnel path.
 */
export type SentryProject = "host" | "worker" | "sandbox";

interface ProjectEnv {
  dsn: string | undefined;
  tunnel: string;
}

function resolveProject(project: SentryProject): ProjectEnv {
  switch (project) {
    case "host":
      return {
        dsn: import.meta.env.VITE_SENTRY_DSN_HOST as string | undefined,
        tunnel: "/t/host",
      };
    case "worker":
      return {
        dsn: import.meta.env.VITE_SENTRY_DSN_WORKER as string | undefined,
        tunnel: "/t/worker",
      };
    case "sandbox":
      return {
        dsn: import.meta.env.VITE_SENTRY_DSN_SANDBOX as string | undefined,
        tunnel: "/t/sandbox",
      };
  }
}

/**
 * Initialize Sentry with the dot.li-standard config for the given project
 * and bind it to `@dotli/metrics` so spans/counters flow through. Safe to
 * call unconditionally — when the DSN env var is unset, Sentry becomes a
 * no-op.
 *
 * Note: `apps/protocol` (the protocol shell iframe) intentionally uses the
 * `"host"` project because it ships on the same origin as the host shell.
 * Its SharedWorker uses `"worker"` because that runs on a separate thread
 * with its own tunnel.
 */
export function initSentry(project: SentryProject): void {
  const { dsn, tunnel } = resolveProject(project);
  Sentry.init({
    dsn,
    tunnel,
    environment:
      (import.meta.env.VITE_APP_ENV as string | undefined) ?? "development",
    release: import.meta.env.VITE_COMMIT_SHA as string | undefined,
    sendDefaultPii: false,
  });
  m.bind(Sentry as unknown as Parameters<typeof m.bind>[0]);
}
