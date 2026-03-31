// dot.li — Protocol host entry point
//
// Three-mode initialization:
//   1. SharedWorker mode — smoldot runs in a SharedWorker shared across tabs
//   2. Leader election mode — Web Locks ensure one leader; followers relay via BroadcastChannel
//   3. Direct mode — current behavior (fallback when no coordination APIs available)

// Reload once on chunk load failure (stale HTML referencing deleted assets).
window.addEventListener("vite:preloadError", () => {
  if (sessionStorage.getItem("dotli:chunk-reload") === null) {
    sessionStorage.setItem("dotli:chunk-reload", "1");
    window.location.reload();
  }
});

import * as Sentry from "@sentry/browser";
import type { JsonRpcConnection } from "@polkadot-api/json-rpc-provider";
import {
  ASSET_HUB_PASEO_GENESIS,
  BASE_DOMAIN,
  MAX_CONNECTIONS_PER_ORIGIN,
  TIMEOUTS,
} from "@dotli/config/config";
import { createChainProvider, isChainSupported } from "@dotli/resolver/chains";
import {
  getRelayChain,
  getSmoldot,
  resolveDotName,
  resolveOwner,
} from "@dotli/resolver/resolve";
import {
  setResolverAssetHubProviderOverride,
  terminateSmoldot,
} from "@dotli/resolver/smoldot";
import { log } from "@dotli/shared/log";
import { createChainBrokerManager } from "@dotli/protocol/broker";
import {
  isProtocolEnvelope,
  type ProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
} from "@dotli/protocol/messages";
import type { SWRelayRequest, SWOutbound } from "./protocol-shared-worker";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN_HOST as string | undefined,
  environment:
    (import.meta.env.VITE_APP_ENV as string | undefined) ?? "development",
  release: import.meta.env.VITE_COMMIT_SHA as string | undefined,
  sendDefaultPii: false,
});

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

function signalReady(): void {
  if (window.parent !== window) {
    window.parent.postMessage(
      { namespace: "dotli:protocol", kind: "ready" } as const,
      "*",
    );
  }
}

// ── Mode detection + initialization ──────────────────────────

async function init(): Promise<void> {
  log.warn("[dot.li protocol] Detecting best coordination mode...");
  log.warn(
    `[dot.li protocol]   SharedWorker: ${typeof SharedWorker !== "undefined" ? "available" : "unavailable"}`,
  );
  log.warn(
    `[dot.li protocol]   Web Locks: ${typeof navigator.locks !== "undefined" ? "available" : "unavailable"}`,
  );
  log.warn(
    `[dot.li protocol]   BroadcastChannel: ${typeof BroadcastChannel !== "undefined" ? "available" : "unavailable"}`,
  );

  // Mode 1: SharedWorker (best — persists across navigations, single instance)
  if (typeof SharedWorker !== "undefined") {
    try {
      log.warn("[dot.li protocol] Attempting SharedWorker mode...");
      await initSharedWorkerMode();
      return;
    } catch (err) {
      log.warn(
        "[dot.li protocol] SharedWorker failed, falling back:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Mode 2: Leader election (good — prevents duplicate smoldot across tabs)
  if (
    typeof navigator.locks !== "undefined" &&
    typeof BroadcastChannel !== "undefined"
  ) {
    log.warn("[dot.li protocol] Using leader election mode...");
    await initLeaderElectionMode();
    return;
  }

  // Mode 3: Direct (fallback — current behavior)
  log.warn(
    "[dot.li protocol] No coordination APIs available, using direct mode",
  );
  initDirectMode();
}

// ── Mode 1: SharedWorker relay ───────────────────────────────

async function initSharedWorkerMode(): Promise<void> {
  const worker = new SharedWorker(
    new URL("./protocol-shared-worker.ts", import.meta.url),
    { type: "module", name: "dotli-protocol" },
  );
  const port = worker.port;

  // Listen for SharedWorker errors (e.g. if the script fails to load)
  worker.addEventListener("error", (event) => {
    log.error("[dot.li protocol] SharedWorker error event:", event);
  });

  // Wait for SharedWorker to signal ready (or error)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("SharedWorker did not signal ready within timeout"));
    }, TIMEOUTS.SHARED_WORKER_READY);

    function onMessage(event: MessageEvent): void {
      const data = event.data as SWOutbound | null;
      if (data?.type === "ready") {
        clearTimeout(timer);
        port.removeEventListener("message", onMessage);
        resolve();
      } else if (data?.type === "error") {
        clearTimeout(timer);
        port.removeEventListener("message", onMessage);
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
    if (!isAllowedOrigin(event.origin)) {
      log.warn(
        `[dot.li protocol] Rejected request from disallowed origin: ${event.origin}`,
      );
      return;
    }

    log.warn(
      `[dot.li protocol] Relaying ${data.method} (id=${data.id}) to SharedWorker`,
    );
    const msg: SWRelayRequest = {
      type: "relay-request",
      envelope: data,
      origin: event.origin,
    };
    port.postMessage(msg);
  });

  // Relay: SharedWorker → parent
  let chainMsgRelayCount = 0;
  port.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as SWOutbound | null;
    if (data?.type === "relay-response" && window.parent !== window) {
      const env = data.envelope;
      if (env.kind === "response") {
        log.warn(
          `[dot.li protocol] Relaying response (id=${env.id}, ok=${String(env.ok)}) to parent`,
        );
      } else if (env.kind === "chain-message") {
        chainMsgRelayCount++;
        if (chainMsgRelayCount <= 5 || chainMsgRelayCount % 100 === 0) {
          log.warn(
            `[dot.li protocol] Relaying chain-message #${String(chainMsgRelayCount)} (conn=${env.connectionId}) to parent`,
          );
        }
      } else if (env.kind === "progress") {
        log.warn(
          `[dot.li protocol] Relaying progress (id=${env.id}) to parent`,
        );
      }
      window.parent.postMessage(env, "*");
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

// ── Mode 2: Leader election (Web Locks + BroadcastChannel) ───

const LOCK_NAME = "dotli:smoldot-leader";
const BC_CHANNEL = "dotli:protocol-bus";

// BroadcastChannel message types
interface BCFollowerRequest {
  type: "bc:follower-request";
  followerId: string;
  envelope: ProtocolRequestEnvelope;
  origin: string;
}

interface BCLeaderResponse {
  type: "bc:leader-response";
  followerId: string;
  envelope: ProtocolEnvelope;
}

type BCMessage = BCFollowerRequest | BCLeaderResponse;

async function initLeaderElectionMode(): Promise<void> {
  const bc = new BroadcastChannel(BC_CHANNEL);

  // Check if a leader already exists
  const lockState = await navigator.locks.query();
  const leaderExists =
    lockState.held?.some((l) => l.name === LOCK_NAME) === true;
  log.warn(
    `[dot.li protocol] Leader lock "${LOCK_NAME}" currently held: ${String(leaderExists)}`,
  );

  if (!leaderExists) {
    // Try to become leader (non-blocking)
    const acquired = await new Promise<boolean>((resolve) => {
      void navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (lock === null) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        // Hold lock until tab/iframe closes (never resolves intentionally)
        return new Promise<void>((_resolve) => {
          /* held indefinitely */
        });
      });
    });

    if (acquired) {
      initLeaderMode(bc);
      return;
    }
  }

  // Leader exists or we lost the race — run as follower
  initFollowerMode(bc);
}

function initLeaderMode(bc: BroadcastChannel): void {
  log.warn("[dot.li protocol] === LEADER ELECTION MODE: LEADER ===");
  log.warn(
    "[dot.li protocol] Smoldot runs in this iframe, followers relay via BroadcastChannel",
  );

  // Initialize engine (same as direct mode)
  const engine = createEngine();

  // Handle parent postMessage requests (from our own host shell)
  window.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isProtocolEnvelope(data) || data.kind !== "request") {
      return;
    }
    if (!isAllowedOrigin(event.origin)) {
      return;
    }

    void engine
      .handleRequest(data, event.origin, (response) => {
        postToSource(event.source, event.origin, response);
      })
      .catch((error: unknown) => {
        postToSource(event.source, event.origin, {
          namespace: "dotli:protocol",
          kind: "response",
          id: data.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });

  // Handle follower requests via BroadcastChannel
  bc.addEventListener("message", (event: MessageEvent) => {
    const msg = event.data as BCMessage;
    if (msg.type !== "bc:follower-request") {
      return;
    }

    void engine
      .handleRequest(msg.envelope, msg.origin, (response) => {
        const reply: BCLeaderResponse = {
          type: "bc:leader-response",
          followerId: msg.followerId,
          envelope: response,
        };
        bc.postMessage(reply);
      })
      .catch((error: unknown) => {
        const reply: BCLeaderResponse = {
          type: "bc:leader-response",
          followerId: msg.followerId,
          envelope: {
            namespace: "dotli:protocol",
            kind: "response",
            id: msg.envelope.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
        };
        bc.postMessage(reply);
      });
  });

  signalReady();

  window.addEventListener("beforeunload", () => {
    engine.cleanup();
    bc.close();
  });
}

function initFollowerMode(bc: BroadcastChannel): void {
  log.warn("[dot.li protocol] === LEADER ELECTION MODE: FOLLOWER ===");
  log.warn(
    "[dot.li protocol] Requests will be relayed to leader via BroadcastChannel",
  );

  const followerId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const pending = new Map<
    string,
    { source: MessageEventSource | null; origin: string }
  >();

  // Forward parent requests to leader via BroadcastChannel
  window.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isProtocolEnvelope(data) || data.kind !== "request") {
      return;
    }
    if (!isAllowedOrigin(event.origin)) {
      return;
    }

    pending.set(data.id, { source: event.source, origin: event.origin });
    log.warn(
      `[dot.li protocol] FOLLOWER: relaying ${data.method} (id=${data.id}) to leader`,
    );
    const msg: BCFollowerRequest = {
      type: "bc:follower-request",
      followerId,
      envelope: data,
      origin: event.origin,
    };
    bc.postMessage(msg);
  });

  // Forward leader responses back to parent
  bc.addEventListener("message", (event: MessageEvent) => {
    const msg = event.data as BCMessage;
    if (msg.type !== "bc:leader-response") {
      return;
    }
    if (msg.followerId !== followerId) {
      return;
    }

    const envelope = msg.envelope;
    // Route based on envelope type
    if (envelope.kind === "response" || envelope.kind === "progress") {
      const req = pending.get(envelope.id);
      if (req) {
        postToSource(req.source, req.origin, envelope);
        if (envelope.kind === "response") {
          pending.delete(envelope.id);
        }
      }
    } else if (envelope.kind === "chain-message") {
      // Chain messages go to parent (the host shell routes them)
      if (window.parent !== window) {
        window.parent.postMessage(envelope, "*");
      }
    }
  });

  signalReady();

  // Queue for promotion — if leader dies, we take over
  void navigator.locks.request(LOCK_NAME, () => {
    log.warn("[dot.li protocol] Leader lock acquired, promoting...");
    bc.close();
    // Reload to start fresh as leader. The parent's protocol client
    // will receive a new "ready" signal after reload.
    window.location.reload();
    return new Promise<void>((_resolve) => {
      /* held until reload */
    });
  });

  window.addEventListener("beforeunload", () => {
    bc.close();
  });
}

// ── Mode 3: Direct mode (fallback) ──────────────────────────

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
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });

  signalReady();

  window.addEventListener("beforeunload", () => {
    engine.cleanup();
  });
}

// ── Protocol engine (shared by leader + direct modes) ────────

type ResponseCallback = (envelope: ProtocolEnvelope) => void;

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
  const ahProvider = broker.getLocalProvider(ASSET_HUB_PASEO_GENESIS) ?? null;

  setResolverAssetHubProviderOverride(ahProvider);
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
    setResolverAssetHubProviderOverride(null);
    terminateSmoldot();
  }

  return { handleRequest, cleanup };
}

// ── Boot ─────────────────────────────────────────────────────

void init().catch((err: unknown) => {
  log.error("[dot.li protocol] Init failed, falling back to direct mode:", err);
  initDirectMode();
});
