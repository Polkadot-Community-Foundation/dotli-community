import * as Sentry from "@sentry/browser";
import type { JsonRpcConnection } from "@polkadot-api/json-rpc-provider";
import { createChainProvider, isChainSupported } from "@dotli/resolver/chains";
import {
  getRelayChain,
  getSmoldot,
  resolveDotName,
  resolveOwner,
} from "@dotli/resolver/resolve";
import { log } from "@dotli/shared/log";
import { BASE_DOMAIN } from "@dotli/config/config";
import {
  isProtocolEnvelope,
  type ProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
} from "@dotli/protocol/messages";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN_HOST as string | undefined,
  environment:
    (import.meta.env.VITE_APP_ENV as string | undefined) ?? "development",
  release: import.meta.env.VITE_COMMIT_SHA as string | undefined,
  sendDefaultPii: false,
});

const MAX_CHAIN_CONNECTIONS = 10;
const chainConnections = new Map<string, JsonRpcConnection>();

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${name}: expected non-empty string`);
  }
}

function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>();
  const hostname = self.location.hostname;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    const port = self.location.port || "5173";
    origins.add(`http://localhost:${port}`);
    origins.add(`http://${hostname}:${port}`);
    // Allow any *.localhost origin for dev
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
  // Allow any subdomain of BASE_DOMAIN (*.dot.li, *.app.dot.li)
  try {
    const url = new URL(origin);
    if (url.hostname.endsWith(`.${BASE_DOMAIN}`)) {
      return true;
    }
    // Dev: allow *.localhost
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

function getConnection(connectionId: string): JsonRpcConnection | undefined {
  return chainConnections.get(connectionId);
}

async function handleRequest(
  event: MessageEvent,
  request: ProtocolRequestEnvelope,
): Promise<void> {
  const origin = event.origin;

  switch (request.method) {
    case "warmup": {
      getSmoldot();
      await getRelayChain();
      postToSource(event.source, origin, {
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
      assertString(payload.label, "label");
      const result = await resolveDotName(payload.label, (message) => {
        postToSource(event.source, origin, {
          namespace: "dotli:protocol",
          kind: "progress",
          id: request.id,
          message,
        });
      });
      postToSource(event.source, origin, {
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
      assertString(payload.label, "label");
      const result = await resolveOwner(payload.label);
      postToSource(event.source, origin, {
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
      assertString(payload.genesisHash, "genesisHash");
      assertString(payload.connectionId, "connectionId");
      if (chainConnections.size >= MAX_CHAIN_CONNECTIONS) {
        throw new Error(
          `Connection limit reached (max ${String(MAX_CHAIN_CONNECTIONS)})`,
        );
      }
      if (!isChainSupported(payload.genesisHash)) {
        throw new Error(`Unsupported chain: ${payload.genesisHash}`);
      }
      const provider = createChainProvider(payload.genesisHash);
      if (provider === null) {
        throw new Error(`Failed to create chain provider`);
      }
      const connection = provider((message) => {
        postToSource(event.source, origin, {
          namespace: "dotli:protocol",
          kind: "chain-message",
          connectionId: payload.connectionId,
          message,
        });
      });
      chainConnections.set(payload.connectionId, connection);
      postToSource(event.source, origin, {
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
      assertString(payload.connectionId, "connectionId");
      assertString(payload.message, "message");
      const connection = getConnection(payload.connectionId);
      connection?.send(payload.message);
      postToSource(event.source, origin, {
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }

    case "chainDisconnect": {
      const payload = request.payload as ProtocolRequestMap["chainDisconnect"];
      assertString(payload.connectionId, "connectionId");
      const connection = getConnection(payload.connectionId);
      connection?.disconnect();
      chainConnections.delete(payload.connectionId);
      postToSource(event.source, origin, {
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

  const request = data;
  void handleRequest(event, request).catch((error: unknown) => {
    log.error("[dot.li protocol] Request failed:", error);
    postToSource(event.source, event.origin, {
      namespace: "dotli:protocol",
      kind: "response",
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
});

window.addEventListener("beforeunload", () => {
  for (const connection of chainConnections.values()) {
    connection.disconnect();
  }
  chainConnections.clear();
});

getSmoldot();
log.warn("[dot.li protocol] Shared protocol host ready");

// Signal readiness to any parent frame that embedded us
if (window.parent !== window) {
  window.parent.postMessage(
    { namespace: "dotli:protocol", kind: "ready" } as const,
    "*",
  );
}
