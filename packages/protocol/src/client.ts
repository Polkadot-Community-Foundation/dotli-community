import type {
  JsonRpcConnection,
  JsonRpcProvider,
} from "@polkadot-api/json-rpc-provider";
import { BASE_DOMAIN } from "@dotli/config/config";
import { log } from "@dotli/shared/log";
import {
  isProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
  type ProtocolRequestMethod,
  SUPPORTED_GENESIS_HASHES,
} from "./messages";

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

let protocolIframe: HTMLIFrameElement | null = null;
let protocolReadyPromise: Promise<void> | null = null;
const pendingRequests = new Map<string, PendingRequest>();
const chainConnections = new Map<string, RemoteChainConnection>();
let listenerBound = false;

function getProtocolOrigin(): string {
  const hostname = window.location.hostname;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    const port =
      window.location.port.length > 0 ? window.location.port : "5173";
    return `http://host.localhost:${port}`;
  }
  return `https://host.${BASE_DOMAIN}`;
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
          pending.reject(new Error(msg.error));
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
        // Handled by ensureProtocolFrame's onReady listener
        return;
    }
  });
}

function createRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// The iframe signals "ready" only after the SharedWorker pre-syncs the chain.
// Cold-start chain sync can take up to ~60s, so allow enough time.
const IFRAME_READY_TIMEOUT_MS = 120_000;
const IFRAME_MAX_RETRIES = 2;

function createProtocolIframe(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.src = getProtocolOrigin();
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    iframe.style.cssText =
      "position:fixed;width:0;height:0;opacity:0;pointer-events:none;border:0;";

    const timer = setTimeout(() => {
      cleanup();
      // Reject unconditionally — if the "ready" message was not received,
      // the protocol host is not listening and all requests would hang.
      iframe.remove();
      reject(new Error("Shared protocol iframe timed out (no ready signal)"));
    }, IFRAME_READY_TIMEOUT_MS);

    const onReady = (event: MessageEvent): void => {
      if (
        event.source !== iframe.contentWindow ||
        !isProtocolEnvelope(event.data) ||
        event.data.kind !== "ready"
      ) {
        return;
      }
      cleanup();
      protocolIframe = iframe;
      resolve();
    };

    const onError = (): void => {
      cleanup();
      reject(new Error("Shared protocol iframe failed to load"));
    };

    function cleanup(): void {
      clearTimeout(timer);
      window.removeEventListener("message", onReady);
      iframe.removeEventListener("error", onError);
    }

    window.addEventListener("message", onReady);
    iframe.addEventListener("error", onError, { once: true });
    document.body.appendChild(iframe);
  });
}

export async function ensureProtocolFrame(): Promise<void> {
  bindMessageListener();

  if (protocolReadyPromise) {
    return protocolReadyPromise;
  }

  protocolReadyPromise = (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= IFRAME_MAX_RETRIES; attempt++) {
      try {
        await createProtocolIframe();
        return;
      } catch (error: unknown) {
        lastError = error;
        log.warn(
          `[dot.li protocol] Iframe attempt ${String(attempt + 1)} failed, ${attempt < IFRAME_MAX_RETRIES ? "retrying..." : "giving up"}`,
        );
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
): Promise<unknown> {
  await ensureProtocolFrame();

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

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(
        new Error(
          `Protocol request "${method}" timed out after ${String(timeoutMs)}ms`,
        ),
      );
    }, timeoutMs);

    pendingRequests.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
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
        const reason =
          error instanceof Error ? error.message : "Chain connection failed";
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
            const reason =
              error instanceof Error ? error.message : "Chain send failed";
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
