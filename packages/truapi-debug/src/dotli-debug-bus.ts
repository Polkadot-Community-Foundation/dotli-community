// dot.li — dotli-internal debug event bus
//
// Module-global pub/sub for boot / resolve / render / bridge / failover
// events. Mirrors the lazy-subscription pattern used by
// `onHostApiDebugMessage` and `onHostPappDebugMessage` so emit cost
// stays near zero when no listener is attached (the primary code path
// checks `hasDotliDebugListeners()` before constructing expensive
// payloads).
//
// Build-time gate: `VITE_APP_DEBUG="true"` activates the real bus;
// any other value (production / dot.li) collapses `DEBUG_BUILD` to
// `false`, the `bus` constant resolves to `null`, every export's
// `if (bus === null) return` early-exits, and Vite's tree-shaker
// drops the `createNanoEvents` import (the package is marked
// `sideEffects: false`). Net result: prod bundles ship empty stubs
// and zero bus state. This const has to live in *this* module —
// importing `DEBUG` from `@dotli/config/config` would turn it into a
// cross-module runtime read that Vite/Rollup will not constant-fold.

import { createNanoEvents } from "nanoevents";

import type { DotliDebugEvent } from "./dotli-debug-types.ts";

const DEBUG_BUILD =
  (import.meta.env.VITE_APP_DEBUG as string | undefined) === "true";

const bus = DEBUG_BUILD
  ? createNanoEvents<{ event: (e: DotliDebugEvent) => void }>()
  : null;
let listenerCount = 0;

/**
 * Early-event buffer. The debug panel is dynamically imported from
 * `apps/host/src/main.ts` and takes tens to hundreds of ms to load —
 * during which the boot-phase emit sites fire. Without buffering,
 * those events are dropped, producing the "sometimes I see more boot
 * events than other times" flake.
 *
 * Semantics: zero cost when debug is never enabled. When enabled
 * explicitly via `enableDotliDebugBuffering()` (called early by
 * `shouldEnableTruapiDebug()` in main.ts), events are retained until
 * the first subscriber attaches, then replayed and buffering is
 * switched off. One-shot — subsequent unsub/resub cycles don't
 * accumulate.
 */
const BUFFER_MAX = 512;
let bufferingEnabled = false;
let bufferedEvents: DotliDebugEvent[] = [];

function noopUnsubscribe(): void {
  /* prod stub returned from `onDotliDebugEvent` when the bus is disabled */
}

/**
 * Opt into retaining events emitted before the first subscriber
 * attaches. Call this as early as possible — ideally right after the
 * decision to enable the debug panel, before any emit site runs.
 */
export function enableDotliDebugBuffering(): void {
  if (bus === null) {
    return;
  }
  bufferingEnabled = true;
}

/** Emit a debug event. Silent no-op when no listener is attached
 *  AND buffering is off. */
export function emitDotliDebugEvent(event: DotliDebugEvent): void {
  if (bus === null) {
    return;
  }
  if (listenerCount > 0) {
    bus.emit("event", event);
    return;
  }
  if (bufferingEnabled) {
    bufferedEvents.push(event);
    if (bufferedEvents.length > BUFFER_MAX) {
      bufferedEvents.shift();
    }
  }
}

/** Cheap gate for emit sites that build non-trivial payloads. */
export function hasDotliDebugListeners(): boolean {
  if (bus === null) {
    return false;
  }
  return listenerCount > 0;
}

/**
 * Subscribe to every dotli debug event. On the first subscribe,
 * replays any events that were emitted while buffering was active;
 * buffering is then switched off for the rest of the session (this
 * is a catch-up mechanism, not a persistent replay log).
 */
export function onDotliDebugEvent(
  callback: (event: DotliDebugEvent) => void,
): () => void {
  if (bus === null) {
    return noopUnsubscribe;
  }
  const wasCold = listenerCount === 0;
  listenerCount++;
  const unsub = bus.on("event", callback);
  if (wasCold && bufferedEvents.length > 0) {
    const replay = bufferedEvents;
    bufferedEvents = [];
    bufferingEnabled = false;
    for (const e of replay) {
      try {
        callback(e);
        // eslint-disable-next-line no-restricted-syntax -- replay errors must not break bus emission; same policy as nanoevents.
      } catch {
        /* swallow */
      }
    }
  }
  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    listenerCount = Math.max(0, listenerCount - 1);
    unsub();
  };
}
