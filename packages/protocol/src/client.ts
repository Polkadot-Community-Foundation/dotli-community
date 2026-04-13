import type {
  JsonRpcConnection,
  JsonRpcProvider,
} from "@polkadot-api/json-rpc-provider";
import {
  BASE_DOMAIN,
  SUPPORTED_GENESIS_HASHES,
  type SiteId,
} from "@dotli/config/config";
import { log } from "@dotli/shared/log";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import {
  isProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
  type ProtocolRequestMethod,
} from "./messages";
import { isSharedAuthRequestMethod } from "./auth-storage";
import { serializeError } from "@dotli/shared/errors";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  onProgress?: (message: string) => void;
}

interface RemoteChainConnection {
  onMessage: (message: string) => void;
  pendingMessages: string[];
  connected: boolean;
}

export interface SharedAuthStorageChange {
  siteId: SiteId;
  key: string;
  value: string | null;
}

export type SharedAuthStorageListener = (
  change: SharedAuthStorageChange,
) => void;

let protocolIframe: HTMLIFrameElement | null = null;
let hostFramePromise: Promise<void> | null = null;
let protocolReadyPromise: Promise<void> | null = null;
const pendingRequests = new Map<string, PendingRequest>();
const chainConnections = new Map<string, RemoteChainConnection>();
const sharedAuthListeners = new Set<SharedAuthStorageListener>();
let listenerBound = false;
let protocolReady = false;
let pendingReadyResolvers: (() => void)[] = [];

function getProtocolOrigin(): string {
  const hostname = window.location.hostname;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    const port =
      window.location.port.length > 0 ? window.location.port : "5173";
    return `http://host.localhost:${port}`;
  }
  return `https://host.${BASE_DOMAIN}`;
}

function resolveProtocolReady(): void {
  if (protocolReady) {
    return;
  }
  protocolReady = true;
  const resolvers = pendingReadyResolvers;
  pendingReadyResolvers = [];
  for (const resolve of resolvers) {
    resolve();
  }
}

function resetProtocolFrameState(): void {
  protocolIframe?.remove();
  protocolIframe = null;
  hostFramePromise = null;
  protocolReadyPromise = null;
  protocolReady = false;
  pendingReadyResolvers = [];
}

function bindMessageListener(): void {
  if (listenerBound) {
    return;
  }
  listenerBound = true;

  window.addEventListener("message", (event: MessageEvent) => {
    if (!isProtocolEnvelope(event.data)) {
      return;
    }

    if (event.origin !== getProtocolOrigin()) {
      return;
    }

    const frameWindow = protocolIframe?.contentWindow;
    if (
      frameWindow !== null &&
      frameWindow !== undefined &&
      event.source !== frameWindow
    ) {
      return;
    }

    const msg = event.data;
    switch (msg.kind) {
      case "progress":
        pendingRequests.get(msg.id)?.onProgress?.(msg.message);
        return;
      case "response": {
        const pending = pendingRequests.get(msg.id);
        if (!pending) {
          return;
        }
        pendingRequests.delete(msg.id);
        if (msg.ok) {
          pending.resolve(msg.result);
        } else {
          const err = new Error(msg.error || "Unknown protocol error");
          err.name = "ProtocolResponseError";
          pending.reject(err);
        }
        return;
      }
      case "chain-message": {
        const conn = chainConnections.get(msg.connectionId);
        if (!conn) {
          log.warn(
            `[dot.li protocol] chain-message for unknown connectionId: ${msg.connectionId} (known: ${[...chainConnections.keys()].join(", ")})`,
          );
          return;
        }
        try {
          conn.onMessage(msg.message);
        } catch (err: unknown) {
          log.error(
            `[dot.li protocol] onMessage threw (conn=${msg.connectionId.slice(-8)}):`,
            err instanceof Error ? err.message : err,
          );
        }
        return;
      }
      case "chain-halt":
        chainConnections.delete(msg.connectionId);
        return;
      case "request":
        // Ignore inbound requests on the client side
        return;
      case "ready":
        resolveProtocolReady();
        return;
      case "auth-storage-changed": {
        const change: SharedAuthStorageChange = {
          siteId: msg.siteId,
          key: msg.key,
          value: msg.value,
        };
        for (const listener of sharedAuthListeners) {
          try {
            listener(change);
          } catch (err: unknown) {
            log.error(
              "[dot.li protocol] Shared auth listener threw:",
              err instanceof Error ? err.message : err,
            );
          }
        }
        return;
      }
    }
  });
}

function createRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const IFRAME_LOAD_TIMEOUT_MS = 30_000;
// The iframe signals "ready" only after the SharedWorker pre-syncs the chain.
// Cold-start chain sync can take up to ~60s, so allow enough time.
const IFRAME_READY_TIMEOUT_MS = 120_000;
const IFRAME_MAX_RETRIES = 2;

function createHostIframe(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.src = getProtocolOrigin();
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    iframe.style.cssText =
      "position:fixed;width:0;height:0;opacity:0;pointer-events:none;border:0;";

    const timer = setTimeout(() => {
      cleanup();
      iframe.remove();
      reject(new Error("Shared host iframe timed out while loading"));
    }, IFRAME_LOAD_TIMEOUT_MS);

    const onLoad = (): void => {
      cleanup();
      protocolIframe = iframe;
      resolve();
    };

    const onError = (): void => {
      cleanup();
      iframe.remove();
      reject(new Error("Shared host iframe failed to load"));
    };

    function cleanup(): void {
      clearTimeout(timer);
      iframe.removeEventListener("load", onLoad);
      iframe.removeEventListener("error", onError);
    }

    iframe.addEventListener("load", onLoad, { once: true });
    iframe.addEventListener("error", onError, { once: true });
    document.body.appendChild(iframe);
  });
}

async function ensureHostFrame(): Promise<void> {
  bindMessageListener();

  if (protocolIframe?.contentWindow) {
    return;
  }

  if (hostFramePromise) {
    return hostFramePromise;
  }

  hostFramePromise = (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= IFRAME_MAX_RETRIES; attempt++) {
      try {
        await createHostIframe();
        return;
      } catch (error: unknown) {
        lastError = error;
        m.count(S.PROTOCOL_IFRAME_RETRY);
        log.warn(
          `[dot.li protocol] Host iframe attempt ${String(attempt + 1)} failed, ${attempt < IFRAME_MAX_RETRIES ? "retrying..." : "giving up"}`,
        );
        resetProtocolFrameState();
      }
    }
    hostFramePromise = null;
    throw lastError;
  })();

  return hostFramePromise;
}

function waitForProtocolReady(): Promise<void> {
  const stopIframe = m.timer(S.PROTOCOL_IFRAME_READY);
  return new Promise<void>((resolve, reject) => {
    if (protocolReady) {
      stopIframe();
      resolve();
      return;
    }

    const onReady = (): void => {
      clearTimeout(timer);
      stopIframe();
      resolve();
    };

    const timer = setTimeout(() => {
      pendingReadyResolvers = pendingReadyResolvers.filter(
        (callback) => callback !== onReady,
      );
      stopIframe();
      reject(new Error("Shared protocol iframe timed out (no ready signal)"));
    }, IFRAME_READY_TIMEOUT_MS);

    pendingReadyResolvers.push(onReady);
  });
}

export async function ensureProtocolFrame(): Promise<void> {
  await ensureHostFrame();

  if (protocolReady) {
    return;
  }

  if (protocolReadyPromise) {
    return protocolReadyPromise;
  }

  protocolReadyPromise = (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= IFRAME_MAX_RETRIES; attempt++) {
      try {
        await waitForProtocolReady();
        return;
      } catch (error: unknown) {
        lastError = error;
        m.count(S.PROTOCOL_IFRAME_RETRY);
        log.warn(
          `[dot.li protocol] Ready wait attempt ${String(attempt + 1)} failed, ${attempt < IFRAME_MAX_RETRIES ? "retrying..." : "giving up"}`,
        );
        resetProtocolFrameState();
        await ensureHostFrame();
      }
    }
    protocolReadyPromise = null;
    throw lastError;
  })();

  return protocolReadyPromise;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const METHOD_TIMEOUTS: Partial<Record<ProtocolRequestMethod, number>> = {
  warmup: 300_000,
  resolveDotName: 300_000,
  resolveOwner: 300_000,
  chainConnect: 30_000,
};

async function postRequest<M extends ProtocolRequestMethod>(
  method: M,
  payload: ProtocolRequestMap[M],
  onProgress?: (message: string) => void,
  needsProtocolReady = !isSharedAuthRequestMethod(method),
): Promise<unknown> {
  await (needsProtocolReady ? ensureProtocolFrame() : ensureHostFrame());
  const frameWindow = protocolIframe?.contentWindow;
  if (!frameWindow) {
    throw new Error("Shared protocol iframe is unavailable");
  }

  const id = createRequestId();
  const envelope: ProtocolRequestEnvelope<M> = {
    namespace: "dotli:protocol",
    kind: "request",
    id,
    method,
    payload,
  };

  const timeoutMs = METHOD_TIMEOUTS[method] ?? DEFAULT_TIMEOUT_MS;
  const stopReq = m.timer(S.PROTOCOL_REQUEST);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      m.count(S.PROTOCOL_REQUEST_TIMEOUT, { method });
      stopReq();
      reject(
        new Error(
          `Protocol request "${method}" timed out after ${String(timeoutMs)}ms`,
        ),
      );
    }, timeoutMs);

    pendingRequests.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        stopReq();
        resolve(value);
      },
      reject: (reason?: unknown) => {
        clearTimeout(timer);
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      },
      onProgress,
    });

    frameWindow.postMessage(envelope, getProtocolOrigin());
  });
}

export async function warmupProtocol(): Promise<void> {
  await postRequest("warmup", {});
}

export async function resolveDotNameRemote(
  label: string,
  onStatus?: (message: string) => void,
): Promise<string | null> {
  return (await postRequest("resolveDotName", { label }, onStatus)) as
    | string
    | null;
}

export async function resolveOwnerRemote(
  label: string,
): Promise<string | null> {
  return (await postRequest("resolveOwner", { label })) as string | null;
}

export async function hasSharedAuthSession(siteId: SiteId): Promise<boolean> {
  return (await postRequest("authHasSession", { siteId })) as boolean;
}

export async function readSharedAuthStorage(
  siteId: SiteId,
  key: string,
): Promise<string | null> {
  return (await postRequest("authStorageRead", { siteId, key })) as
    | string
    | null;
}

export async function writeSharedAuthStorage(
  siteId: SiteId,
  key: string,
  value: string,
): Promise<void> {
  await postRequest("authStorageWrite", { siteId, key, value });
}

export async function clearSharedAuthStorage(
  siteId: SiteId,
  key: string,
): Promise<void> {
  await postRequest("authStorageClear", { siteId, key });
}

/**
 * Subscribe to cross-tab shared auth storage changes.
 *
 * Writes and clears performed by *sibling tabs* of the same root domain (e.g.
 * another `*.dot.li` tab) arrive here as notifications. The originating tab
 * does NOT receive its own writes via this channel — it already emits to local
 * listeners inline when its own `write`/`clear` resolves.
 *
 * Ensures the host iframe is created so it can relay `BroadcastChannel`
 * notifications from sibling host iframes. The returned function unsubscribes.
 */
export function subscribeSharedAuthStorage(
  listener: SharedAuthStorageListener,
): () => void {
  sharedAuthListeners.add(listener);
  // Best-effort iframe warm-up so the relay path is live. We intentionally
  // don't await or surface errors — the caller's subscribe contract is
  // synchronous, and the iframe will be lazily (re)created on the next
  // explicit request if this warm-up fails.
  void ensureHostFrame().catch((error: unknown) => {
    log.warn(
      "[dot.li protocol] Failed to ensure host frame for shared auth subscription:",
      error,
    );
  });
  return () => {
    sharedAuthListeners.delete(listener);
  };
}

export function isRemoteChainSupported(genesisHash: string): boolean {
  return SUPPORTED_GENESIS_HASHES.has(genesisHash.toLowerCase());
}

/**
 * Build a JSON-RPC error response string for a given request.
 * Parses the request to extract its `id`, then wraps the error message.
 * If the request can't be parsed, returns null (nothing to respond to).
 */
function buildJsonRpcError(
  request: string,
  errorMessage: string,
): string | null {
  try {
    const parsed = JSON.parse(request) as { id?: unknown };
    if (parsed.id === undefined || parsed.id === null) {
      return null;
    }
    return JSON.stringify({
      jsonrpc: "2.0",
      id: parsed.id,
      error: { code: -32603, message: errorMessage },
    });
  } catch {
    return null;
  }
}

export function createRemoteChainProvider(
  genesisHash: string,
): JsonRpcProvider | null {
  if (!isRemoteChainSupported(genesisHash)) {
    return null;
  }

  return (onMessage): JsonRpcConnection => {
    const connectionId = createRequestId();
    const remote: RemoteChainConnection = {
      onMessage,
      pendingMessages: [],
      connected: false,
    };

    chainConnections.set(connectionId, remote);

    void ensureProtocolFrame()
      .then(async () => {
        await postRequest("chainConnect", { genesisHash, connectionId });
        remote.connected = true;
        for (const message of remote.pendingMessages) {
          void postRequest("chainSend", { connectionId, message });
        }
        remote.pendingMessages = [];
      })
      .catch((error: unknown) => {
        // Connection failed — send JSON-RPC error responses for all
        // pending messages so polkadot-api's client knows the connection
        // died instead of hanging on "Not connected" forever.
        const reason = serializeError(error);
        log.error("[dot.li protocol] Failed to connect remote chain:", error);
        for (const pending of remote.pendingMessages) {
          const errResponse = buildJsonRpcError(pending, reason);
          if (errResponse !== null) {
            onMessage(errResponse);
          }
        }
        remote.pendingMessages = [];
        chainConnections.delete(connectionId);
      });

    return {
      send(message) {
        const current = chainConnections.get(connectionId);
        if (!current) {
          // Connection was removed (failed or disconnected).
          // Respond with an error so the caller doesn't hang.
          const errResponse = buildJsonRpcError(
            message,
            "Chain connection is closed",
          );
          if (errResponse !== null) {
            onMessage(errResponse);
          }
          return;
        }
        if (!current.connected) {
          current.pendingMessages.push(message);
          return;
        }
        void postRequest("chainSend", { connectionId, message }).catch(
          (error: unknown) => {
            const reason = serializeError(error);
            log.error("[dot.li protocol] Remote chain send failed:", error);
            const errResponse = buildJsonRpcError(message, reason);
            if (errResponse !== null) {
              onMessage(errResponse);
            }
          },
        );
      },
      disconnect() {
        const current = chainConnections.get(connectionId);
        chainConnections.delete(connectionId);
        if (!current) {
          return;
        }
        void postRequest("chainDisconnect", { connectionId }).catch(
          (error: unknown) => {
            log.warn("[dot.li protocol] Remote disconnect failed:", error);
          },
        );
      },
    };
  };
}
