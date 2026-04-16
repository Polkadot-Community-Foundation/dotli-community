// dot.li — Protocol host entry point
//
// Two modes, selected explicitly via `?mode=` URL parameter:
//   1. SharedWorker mode — smoldot runs in a SharedWorker shared across tabs
//   2. Direct mode — smoldot runs in this iframe with no cross-tab coordination

// Reload once on chunk load failure (stale HTML referencing deleted assets).
window.addEventListener("vite:preloadError", () => {
  if (sessionStorage.getItem("dotli:chunk-reload") === null) {
    sessionStorage.setItem("dotli:chunk-reload", "1");
    window.location.reload();
  }
});

import { initSentry } from "@dotli/metrics/sentry";
import type { JsonRpcConnection } from "@polkadot-api/json-rpc-provider";
import {
  BASE_DOMAIN,
  MAX_CONNECTIONS_PER_ORIGIN,
  SITE_ID,
  TIMEOUTS,
  type SiteId,
} from "@dotli/config/config";
import { createChainProvider, isChainSupported } from "@dotli/resolver/chains";
import {
  getRelayChain,
  getSmoldot,
  resolveDotName,
  resolveOwner,
} from "@dotli/resolver/resolve";
import { terminateSmoldot } from "@dotli/resolver/smoldot";
import { log } from "@dotli/shared/log";
import { serializeError } from "@dotli/shared/errors";
import { createChainBrokerManager } from "@dotli/protocol/broker";
import {
  buildSharedAuthStorageKey,
  hasStoredSharedAuthSession,
  isSharedAuthOriginAllowed,
  isSharedAuthRequestMethod,
  isSharedAuthSiteId,
  isSharedAuthStorageKey,
  SHARED_AUTH_SESSION_KEY,
} from "@dotli/protocol/auth-storage";
import {
  isProtocolEnvelope,
  type ProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
} from "@dotli/protocol/messages";
import type { SWRelayRequest, SWOutbound } from "./protocol-shared-worker";

initSentry("host");

import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";

// ── Origin validation (shared across all modes) ──────────────

function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>();
  const hostname = self.location.hostname;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    const port = self.location.port || "5173";
    origins.add(`http://localhost:${port}`);
    origins.add(`http://${hostname}:${port}`);
    return origins;
  }
  origins.add(`https://${BASE_DOMAIN}`);
  origins.add(`https://host.${BASE_DOMAIN}`);
  return origins;
}

function isAllowedOrigin(origin: string): boolean {
  const allowed = getAllowedOrigins();
  if (allowed.has(origin)) {
    return true;
  }
  try {
    const url = new URL(origin);
    if (url.hostname.endsWith(`.${BASE_DOMAIN}`)) {
      return true;
    }
    if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
      return true;
    }
  } catch {
    // invalid origin
  }
  return false;
}

function postToSource(
  source: MessageEventSource | null,
  origin: string,
  message: ProtocolEnvelope,
): void {
  if (!source) {
    return;
  }
  (source as Window).postMessage(message, origin);
}

// ── Shared-auth cross-tab broadcast ──────────────────────────
//
// The shared-auth path is intentionally handled on the host window (not in the
// SharedWorker) because it only needs `localStorage` — no smoldot, no chain.
// Each tab embeds its own host iframe, so when tab A writes a session, tab B's
// adapter subscribers need to be notified. We bridge tabs with a
// `BroadcastChannel` scoped to the host origin:
//
//   1. Tab A's host iframe receives an `authStorageWrite` request from its
//      parent and writes to localStorage.
//   2. Tab A's host iframe posts `{ siteId, key, value }` on the
//      `dotli:shared-auth` BroadcastChannel.
//   3. Tab B's host iframe (different window, same origin) receives the
//      broadcast and forwards it to *its* parent window via `postMessage` as
//      an `auth-storage-changed` envelope.
//   4. The parent window's protocol client dispatches to local subscribers.
//
// The originating tab does NOT receive its own BroadcastChannel message (per
// spec), so tab A's local subscribers fire via the in-process `emit` in
// `createSharedAuthStorageAdapter`'s `.map(() => emit(...))` chain — there is
// no double-dispatch.

const SHARED_AUTH_BROADCAST_CHANNEL = "dotli:shared-auth";

interface SharedAuthBroadcastMessage {
  siteId: SiteId;
  key: string;
  value: string | null;
}

const sharedAuthChannel: BroadcastChannel | null =
  typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(SHARED_AUTH_BROADCAST_CHANNEL)
    : null;

// The origin of the parent window embedding this host iframe. Populated from
// `document.referrer` at module load (best-effort — may be blank under strict
// referrer policies) and refreshed on every validated shared-auth request.
// Broadcasts are only forwarded to the parent when we know its origin, so
// unrelated embedders never receive a shared-auth change notification.
let parentOrigin: string | null = initialParentOriginFromReferrer();

function initialParentOriginFromReferrer(): string | null {
  try {
    const ref = document.referrer;
    if (ref === "") {
      return null;
    }
    const origin = new URL(ref).origin;
    return isAllowedOrigin(origin) ? origin : null;
  } catch {
    return null;
  }
}

function broadcastSharedAuthChange(
  siteId: SiteId,
  key: string,
  value: string | null,
): void {
  if (sharedAuthChannel === null) {
    return;
  }
  try {
    const msg: SharedAuthBroadcastMessage = { siteId, key, value };
    sharedAuthChannel.postMessage(msg);
  } catch (error: unknown) {
    log.warn("[dot.li protocol] Shared auth broadcast failed:", error);
  }
}

function isSharedAuthBroadcastMessage(
  value: unknown,
): value is SharedAuthBroadcastMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as {
    siteId?: unknown;
    key?: unknown;
    value?: unknown;
  };
  return (
    typeof obj.siteId === "string" &&
    typeof obj.key === "string" &&
    (obj.value === null || typeof obj.value === "string")
  );
}

function bindSharedAuthBroadcastRelay(): void {
  if (sharedAuthChannel === null) {
    return;
  }
  sharedAuthChannel.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isSharedAuthBroadcastMessage(data)) {
      return;
    }
    // Only the current host's SiteId is valid (see `isSharedAuthSiteId`). We
    // still defensively filter here so stale broadcasts from a different
    // root domain (which shouldn't happen — the channel is origin-scoped)
    // cannot leak across trust boundaries.
    if (data.siteId !== SITE_ID) {
      return;
    }
    if (parentOrigin === null || window.parent === window) {
      return;
    }
    try {
      window.parent.postMessage(
        {
          namespace: "dotli:protocol",
          kind: "auth-storage-changed",
          siteId: data.siteId,
          key: data.key,
          value: data.value,
        } as const,
        parentOrigin,
      );
    } catch (error: unknown) {
      log.warn(
        "[dot.li protocol] Failed to forward shared auth change to parent:",
        error,
      );
    }
  });
}

function bindSharedAuthListener(): void {
  window.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      !isProtocolEnvelope(data) ||
      data.kind !== "request" ||
      !isSharedAuthRequestMethod(data.method)
    ) {
      return;
    }
    // First gate: the broad protocol origin allowlist (`*.<BASE_DOMAIN>` +
    // localhost). The narrower shared-auth allowlist — which additionally
    // rejects `app.<BASE_DOMAIN>` and sandboxed SPA subdomains — runs inside
    // `handleSharedAuthRequest` via `assertSharedAuthOrigin`.
    if (!isAllowedOrigin(event.origin)) {
      log.warn(
        `[dot.li protocol] Rejected shared-auth request from disallowed origin: ${event.origin}`,
      );
      return;
    }
    // Remember the parent origin so cross-tab broadcast forwards target a
    // known origin rather than `*`. This runs on every request, not just the
    // first, so we tolerate (unlikely) parent navigations that replace the
    // embedding page.
    parentOrigin = event.origin;

    try {
      handleSharedAuthRequest(data, event.origin, (response) => {
        postToSource(event.source, event.origin, response);
      });
    } catch (error: unknown) {
      postToSource(event.source, event.origin, {
        namespace: "dotli:protocol",
        kind: "response",
        id: data.id,
        ok: false,
        error: serializeError(error),
      });
    }
  });
}

function signalReady(): void {
  if (window.parent !== window) {
    window.parent.postMessage(
      { namespace: "dotli:protocol", kind: "ready" } as const,
      "*",
    );
  }
}

// ── Mode initialization (explicit, no auto-detection) ───────

function getRequestedMode(): "shared-worker" | "direct" | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("mode");
    if (mode === "shared-worker" || mode === "direct") {
      return mode;
    }
  } catch {
    // URL parsing failed
  }
  // No mode param → iframe was loaded for shared auth only, not smoldot
  return null;
}

async function init(): Promise<void> {
  const mode = getRequestedMode();

  // When no mode is requested, the iframe is only serving shared auth
  // storage requests (localStorage). No smoldot needed.
  if (mode === null) {
    log.warn(
      "[dot.li protocol] No mode requested — auth-only iframe, skipping smoldot",
    );
    signalReady();
    return;
  }

  const stopInit = m.timer(S.PROTOCOL_INIT);
  log.warn(`[dot.li protocol] Requested mode: ${mode}`);

  if (mode === "shared-worker") {
    if (typeof SharedWorker === "undefined") {
      const msg = "SharedWorker is not available in this browser";
      log.error(`[dot.li protocol] ${msg}`);
      signalError(msg);
      stopInit();
      return;
    }
    await initSharedWorkerMode();
    m.tag("protocol_mode", "shared_worker");
    m.count(S.PROTOCOL_MODE, { mode: "shared_worker" });
  } else {
    initDirectMode();
    m.tag("protocol_mode", "direct");
    m.count(S.PROTOCOL_MODE, { mode: "direct" });
  }

  stopInit();
}

function signalError(message: string): void {
  if (window.parent !== window) {
    window.parent.postMessage(
      {
        namespace: "dotli:protocol",
        kind: "response",
        id: "__init__",
        ok: false,
        error: message,
      } as const,
      "*",
    );
  }
}

// ── Mode 1: SharedWorker relay ───────────────────────────────

async function initSharedWorkerMode(): Promise<void> {
  const swStartTime = performance.now();

  const worker = new SharedWorker(
    new URL("./protocol-shared-worker.ts", import.meta.url),
    { type: "module", name: "dotli-protocol" },
  );
  const port = worker.port;

  // Listen for SharedWorker errors (e.g. if the script fails to load)
  worker.addEventListener("error", (event) => {
    log.error("[dot.li protocol] SharedWorker error event:", event);
    m.count(S.BOOTNODE_ERROR, { source: "shared_worker" });
  });

  // Wait for SharedWorker to signal ready (or error)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const waitMs = performance.now() - swStartTime;
      m.distribution(S.PROTOCOL_SW_READY, waitMs, "millisecond", {
        outcome: "timeout",
      });
      reject(new Error("SharedWorker did not signal ready within timeout"));
    }, TIMEOUTS.SHARED_WORKER_READY);

    function onMessage(event: MessageEvent): void {
      const data = event.data as SWOutbound | null;
      if (data?.type === "ready") {
        clearTimeout(timer);
        port.removeEventListener("message", onMessage);
        const readyMs = performance.now() - swStartTime;
        m.measure(S.PROTOCOL_SW_READY, readyMs);
        m.distribution(S.PROTOCOL_SW_READY, readyMs, "millisecond", {
          outcome: "success",
        });
        resolve();
      } else if (data?.type === "error") {
        clearTimeout(timer);
        port.removeEventListener("message", onMessage);
        const failMs = performance.now() - swStartTime;
        m.distribution(S.PROTOCOL_SW_READY, failMs, "millisecond", {
          outcome: "error",
        });
        reject(new Error(`SharedWorker error: ${data.message}`));
      }
    }

    port.addEventListener("message", onMessage);
    port.start();
  });

  log.warn("[dot.li protocol] === SHARED WORKER MODE ACTIVE ===");
  log.warn(
    "[dot.li protocol] Smoldot runs in SharedWorker, persists across navigations",
  );

  // Relay: parent postMessage → SharedWorker
  window.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isProtocolEnvelope(data) || data.kind !== "request") {
      return;
    }
    if (isSharedAuthRequestMethod(data.method)) {
      return;
    }
    if (!isAllowedOrigin(event.origin)) {
      log.warn(
        `[dot.li protocol] Rejected request from disallowed origin: ${event.origin}`,
      );
      return;
    }

    const msg: SWRelayRequest = {
      type: "relay-request",
      envelope: data,
      origin: event.origin,
    };
    port.postMessage(msg);
  });

  // Relay: SharedWorker → parent
  port.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as SWOutbound | null;
    if (data?.type === "relay-response" && window.parent !== window) {
      window.parent.postMessage(data.envelope, "*");
    }
  });

  signalReady();

  window.addEventListener("beforeunload", () => {
    log.warn(
      "[dot.li protocol] Iframe unloading, sending disconnect to SharedWorker",
    );
    try {
      port.postMessage({ type: "disconnect" });
    } catch {
      /* port already closed */
    }
    port.close();
  });
}

// ── Direct mode ─────────────────────────────────────────────

function initDirectMode(): void {
  log.warn("[dot.li protocol] === DIRECT MODE ===");
  log.warn(
    "[dot.li protocol] Smoldot runs in this iframe with no cross-tab coordination",
  );

  const engine = createEngine();

  window.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isProtocolEnvelope(data) || data.kind !== "request") {
      return;
    }
    if (isSharedAuthRequestMethod(data.method)) {
      return;
    }
    if (!isAllowedOrigin(event.origin)) {
      log.warn(
        `[dot.li protocol] Rejected request from disallowed origin: ${event.origin}`,
      );
      return;
    }

    void engine
      .handleRequest(data, event.origin, (response) => {
        postToSource(event.source, event.origin, response);
      })
      .catch((error: unknown) => {
        log.error("[dot.li protocol] Request failed:", error);
        postToSource(event.source, event.origin, {
          namespace: "dotli:protocol",
          kind: "response",
          id: data.id,
          ok: false,
          error: serializeError(error),
        });
      });
  });

  signalReady();

  window.addEventListener("beforeunload", () => {
    engine.cleanup();
  });
}

// ── Protocol engine (used by direct mode) ────────────────────

type ResponseCallback = (envelope: ProtocolEnvelope) => void;

function assertSharedAuthSiteId(value: unknown): asserts value is SiteId {
  if (typeof value !== "string" || !isSharedAuthSiteId(value)) {
    throw new Error(`Invalid siteId: ${String(value)}`);
  }
}

function assertSharedAuthKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || !isSharedAuthStorageKey(value)) {
    throw new Error(`Invalid shared auth key: ${String(value)}`);
  }
}

function assertSharedAuthOrigin(origin: string): void {
  if (!isSharedAuthOriginAllowed(origin)) {
    throw new Error(`Shared auth request denied from origin: ${origin}`);
  }
}

function handleSharedAuthRequest(
  request: ProtocolRequestEnvelope,
  origin: string,
  respond: ResponseCallback,
): void {
  if (!isSharedAuthRequestMethod(request.method)) {
    throw new Error(`Not a shared auth request: ${request.method as string}`);
  }

  assertSharedAuthOrigin(origin);

  switch (request.method) {
    case "authHasSession": {
      const payload = request.payload as ProtocolRequestMap["authHasSession"];
      assertSharedAuthSiteId(payload.siteId);
      const value = localStorage.getItem(
        buildSharedAuthStorageKey(payload.siteId, SHARED_AUTH_SESSION_KEY),
      );
      respond({
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result: hasStoredSharedAuthSession(value),
      });
      return;
    }

    case "authStorageRead": {
      const payload = request.payload as ProtocolRequestMap["authStorageRead"];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedAuthKey(payload.key);
      respond({
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result: localStorage.getItem(
          buildSharedAuthStorageKey(payload.siteId, payload.key),
        ),
      });
      return;
    }

    case "authStorageWrite": {
      const payload = request.payload as ProtocolRequestMap["authStorageWrite"];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedAuthKey(payload.key);
      if (typeof payload.value !== "string") {
        throw new Error("Invalid shared auth value");
      }
      localStorage.setItem(
        buildSharedAuthStorageKey(payload.siteId, payload.key),
        payload.value,
      );
      broadcastSharedAuthChange(payload.siteId, payload.key, payload.value);
      respond({
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }

    case "authStorageClear": {
      const payload = request.payload as ProtocolRequestMap["authStorageClear"];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedAuthKey(payload.key);
      localStorage.removeItem(
        buildSharedAuthStorageKey(payload.siteId, payload.key),
      );
      broadcastSharedAuthChange(payload.siteId, payload.key, null);
      respond({
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }
  }
}

interface ProtocolEngine {
  handleRequest: (
    request: ProtocolRequestEnvelope,
    origin: string,
    respond: ResponseCallback,
  ) => Promise<void>;
  cleanup: () => void;
}

function createEngine(): ProtocolEngine {
  const MAX_CONNS = 10;
  const connections = new Map<string, JsonRpcConnection>();
  const originConns = new Map<string, Set<string>>();
  const broker = createChainBrokerManager(createChainProvider);
  getSmoldot();

  function assertStr(value: unknown, name: string): asserts value is string {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Invalid ${name}: expected non-empty string`);
    }
  }

  async function handleRequest(
    request: ProtocolRequestEnvelope,
    origin: string,
    respond: ResponseCallback,
  ): Promise<void> {
    if (isSharedAuthRequestMethod(request.method)) {
      handleSharedAuthRequest(request, origin, respond);
      return;
    }

    switch (request.method) {
      case "warmup": {
        getSmoldot();
        await getRelayChain();
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result: true,
        });
        return;
      }

      case "resolveDotName": {
        const payload = request.payload as ProtocolRequestMap["resolveDotName"];
        assertStr(payload.label, "label");
        const result = await resolveDotName(payload.label, (message) => {
          respond({
            namespace: "dotli:protocol",
            kind: "progress",
            id: request.id,
            message,
          });
        });
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result,
        });
        return;
      }

      case "resolveOwner": {
        const payload = request.payload as ProtocolRequestMap["resolveOwner"];
        assertStr(payload.label, "label");
        const result = await resolveOwner(payload.label);
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result,
        });
        return;
      }

      case "chainConnect": {
        const payload = request.payload as ProtocolRequestMap["chainConnect"];
        assertStr(payload.genesisHash, "genesisHash");
        assertStr(payload.connectionId, "connectionId");
        if (connections.size >= MAX_CONNS) {
          throw new Error(
            `Connection limit reached (max ${String(MAX_CONNS)})`,
          );
        }
        const oc = originConns.get(origin) ?? new Set<string>();
        if (oc.size >= MAX_CONNECTIONS_PER_ORIGIN) {
          throw new Error(
            `Per-origin connection limit reached (max ${String(MAX_CONNECTIONS_PER_ORIGIN)})`,
          );
        }
        if (!isChainSupported(payload.genesisHash)) {
          throw new Error(`Unsupported chain: ${payload.genesisHash}`);
        }
        const connection = broker.connectRemote(
          payload.genesisHash,
          payload.connectionId,
          (message) => {
            respond({
              namespace: "dotli:protocol",
              kind: "chain-message",
              connectionId: payload.connectionId,
              message,
            });
          },
        );
        if (connection === null) {
          throw new Error("Failed to create chain broker");
        }
        connections.set(payload.connectionId, connection);
        oc.add(payload.connectionId);
        originConns.set(origin, oc);
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result: true,
        });
        return;
      }

      case "chainSend": {
        const payload = request.payload as ProtocolRequestMap["chainSend"];
        assertStr(payload.connectionId, "connectionId");
        assertStr(payload.message, "message");
        const conn = connections.get(payload.connectionId);
        if (conn === undefined) {
          throw new Error(`Unknown chain connection: ${payload.connectionId}`);
        }
        conn.send(payload.message);
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result: true,
        });
        return;
      }

      case "chainDisconnect": {
        const payload =
          request.payload as ProtocolRequestMap["chainDisconnect"];
        assertStr(payload.connectionId, "connectionId");
        const conn = connections.get(payload.connectionId);
        conn?.disconnect();
        connections.delete(payload.connectionId);
        for (const [orig, conns] of originConns) {
          conns.delete(payload.connectionId);
          if (conns.size === 0) {
            originConns.delete(orig);
          }
        }
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result: true,
        });
        return;
      }

      default: {
        const _method: never = request.method;
        throw new Error(`Unknown protocol method: ${_method as string}`);
      }
    }
  }

  function cleanup(): void {
    for (const conn of connections.values()) {
      conn.disconnect();
    }
    connections.clear();
    originConns.clear();
    broker.disconnectAll();
    terminateSmoldot();
  }

  return { handleRequest, cleanup };
}

// ── Boot ─────────────────────────────────────────────────────

bindSharedAuthListener();
bindSharedAuthBroadcastRelay();

void init().catch((err: unknown) => {
  log.error("[dot.li protocol] Init failed:", err);
  signalError(err instanceof Error ? err.message : String(err));
});
