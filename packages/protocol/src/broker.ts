import type {
  JsonRpcConnection,
  JsonRpcProvider,
} from "@polkadot-api/json-rpc-provider";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: JsonRpcId;
  result?: unknown;
  error?: unknown;
}

interface SubscriptionMessage {
  jsonrpc?: string;
  method?: unknown;
  params?: {
    subscription?: unknown;
    result?: unknown;
  };
}

interface PendingRequest {
  sessionId: string;
  clientId: JsonRpcId;
  method: string;
}

interface OwnedToken {
  sessionId: string;
  localToken: string;
  releaseMethod: string;
}

interface Session {
  id: string;
  onMessage: (message: string) => void;
  ownedTokens: Set<string>;
  connected: boolean;
}

const TOKEN_METHODS = new Map<string, string>([
  ["chainHead_v1_follow", "chainHead_v1_unfollow"],
  ["transaction_v1_broadcast", "transaction_v1_stop"],
]);

function isJsonRpcObject(
  value: unknown,
): value is Record<string, unknown> & { jsonrpc?: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildJsonRpcError(id: JsonRpcId, message: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32603, message },
  });
}

function isRequestMessage(value: unknown): value is JsonRpcRequest {
  return isJsonRpcObject(value) && typeof value.method === "string";
}

function isResponseMessage(value: unknown): value is JsonRpcResponse {
  return isJsonRpcObject(value) && "id" in value && !("method" in value);
}

function isSubscriptionMessage(value: unknown): value is SubscriptionMessage {
  return (
    isJsonRpcObject(value) &&
    "method" in value &&
    isJsonRpcObject(value.params) &&
    "subscription" in value.params
  );
}

function cloneWithRewrittenFirstParam(
  request: JsonRpcRequest,
  rewrittenToken: string,
): JsonRpcRequest {
  const params: unknown[] = Array.isArray(request.params)
    ? [...(request.params as unknown[])]
    : [];
  params[0] = rewrittenToken;
  return { ...request, params };
}

export interface ChainBrokerManager {
  connectRemote(
    genesisHash: string,
    connectionId: string,
    onMessage: (message: string) => void,
  ): JsonRpcConnection | null;
  getLocalProvider(genesisHash: string): JsonRpcProvider | null;
  disconnectAll(): void;
}

class ChainBroker {
  private readonly provider: JsonRpcProvider;
  private readonly onEmpty: () => void;
  private upstream: JsonRpcConnection | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly localToOwned = new Map<string, OwnedToken>();
  private readonly upstreamToOwned = new Map<string, OwnedToken>();
  private requestCounter = 0;
  private tokenCounter = 0;

  constructor(provider: JsonRpcProvider, onEmpty: () => void) {
    this.provider = provider;
    this.onEmpty = onEmpty;
  }

  connect(
    sessionId: string,
    onMessage: (message: string) => void,
  ): JsonRpcConnection {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Duplicate broker session: ${sessionId}`);
    }

    this.ensureUpstream();
    this.sessions.set(sessionId, {
      id: sessionId,
      onMessage,
      ownedTokens: new Set<string>(),
      connected: true,
    });

    return {
      send: (message) => {
        this.sendFromSession(sessionId, message);
      },
      disconnect: () => {
        this.disconnectSession(sessionId);
      },
    };
  }

  disconnectAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.disconnectSession(sessionId);
    }
    this.disconnectUpstream();
  }

  private ensureUpstream(): void {
    if (this.upstream !== null) {
      return;
    }
    this.upstream = this.provider((message) => {
      this.handleUpstreamMessage(message);
    });
  }

  private sendFromSession(sessionId: string, message: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.connected !== true) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      session.onMessage(buildJsonRpcError(null, "Invalid JSON-RPC payload"));
      return;
    }

    if (Array.isArray(parsed)) {
      session.onMessage(
        buildJsonRpcError(null, "Batch JSON-RPC is unsupported"),
      );
      return;
    }

    if (!isRequestMessage(parsed)) {
      session.onMessage(buildJsonRpcError(null, "Invalid JSON-RPC request"));
      return;
    }

    const rewritten = this.rewriteOwnedToken(session, parsed);
    if (rewritten === null) {
      session.onMessage(
        buildJsonRpcError(parsed.id ?? null, "Unknown subscription/token"),
      );
      return;
    }

    if (parsed.id === undefined) {
      this.upstream?.send(JSON.stringify(rewritten));
      return;
    }

    const upstreamId = `broker:${this.requestCounter.toString(36)}:${sessionId}`;
    this.requestCounter += 1;
    this.pending.set(upstreamId, {
      sessionId,
      clientId: parsed.id ?? null,
      method: parsed.method as string,
    });
    this.upstream?.send(JSON.stringify({ ...rewritten, id: upstreamId }));
  }

  private rewriteOwnedToken(
    session: Session,
    request: JsonRpcRequest,
  ): JsonRpcRequest | null {
    if (!Array.isArray(request.params) || request.params.length === 0) {
      return request;
    }

    const firstParam: unknown = request.params[0];
    if (typeof firstParam !== "string") {
      return request;
    }

    const owned = this.localToOwned.get(firstParam);
    if (!owned) {
      return request;
    }

    if (owned.sessionId !== session.id) {
      return null;
    }

    const upstreamToken = this.getUpstreamToken(firstParam);
    if (upstreamToken === null) {
      return null;
    }

    return cloneWithRewrittenFirstParam(request, upstreamToken);
  }

  private getUpstreamToken(localToken: string): string | null {
    for (const [upstreamToken, owned] of this.upstreamToOwned.entries()) {
      if (owned.localToken === localToken) {
        return upstreamToken;
      }
    }
    return null;
  }

  private handleUpstreamMessage(message: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }

    if (Array.isArray(parsed)) {
      return;
    }

    if (isResponseMessage(parsed)) {
      this.handleUpstreamResponse(parsed);
      return;
    }

    if (isSubscriptionMessage(parsed)) {
      this.handleUpstreamSubscription(parsed);
    }
  }

  private handleUpstreamResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(String(response.id));
    if (!pending) {
      return;
    }
    this.pending.delete(String(response.id));

    const session = this.sessions.get(pending.sessionId);
    if (session?.connected !== true) {
      return;
    }

    let result: unknown = response.result;
    const releaseMethod = TOKEN_METHODS.get(pending.method);
    if (releaseMethod !== undefined && typeof response.result === "string") {
      const localToken = `token:${this.tokenCounter.toString(36)}:${pending.sessionId}`;
      this.tokenCounter += 1;
      const owned: OwnedToken = {
        sessionId: pending.sessionId,
        localToken,
        releaseMethod,
      };
      this.localToOwned.set(localToken, owned);
      this.upstreamToOwned.set(response.result, owned);
      session.ownedTokens.add(localToken);
      result = localToken;
    }

    const rewritten: Record<string, unknown> = {
      ...response,
      id: pending.clientId,
    };
    if ("result" in response) {
      rewritten.result = result;
    }
    session.onMessage(JSON.stringify(rewritten));
  }

  private handleUpstreamSubscription(message: SubscriptionMessage): void {
    const upstreamToken = message.params?.subscription;
    if (typeof upstreamToken !== "string") {
      return;
    }

    const owned = this.upstreamToOwned.get(upstreamToken);
    if (!owned) {
      return;
    }

    const session = this.sessions.get(owned.sessionId);
    if (session?.connected !== true) {
      return;
    }

    session.onMessage(
      JSON.stringify({
        ...message,
        params: {
          ...message.params,
          subscription: owned.localToken,
        },
      }),
    );

    const eventResult = message.params?.result;
    if (isJsonRpcObject(eventResult) && eventResult.event === "stop") {
      this.releaseOwnedToken(owned.localToken, false);
    }
  }

  private disconnectSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.connected = false;
    this.sessions.delete(sessionId);

    for (const requestId of [...this.pending.keys()]) {
      if (this.pending.get(requestId)?.sessionId === sessionId) {
        this.pending.delete(requestId);
      }
    }

    for (const localToken of [...session.ownedTokens]) {
      this.releaseOwnedToken(localToken, true);
    }

    if (this.sessions.size === 0) {
      this.disconnectUpstream();
      this.onEmpty();
    }
  }

  private releaseOwnedToken(localToken: string, notifyUpstream: boolean): void {
    const owned = this.localToOwned.get(localToken);
    if (!owned) {
      return;
    }

    this.localToOwned.delete(localToken);
    const session = this.sessions.get(owned.sessionId);
    session?.ownedTokens.delete(localToken);

    let upstreamTokenToDelete: string | null = null;
    for (const [upstreamToken, candidate] of this.upstreamToOwned.entries()) {
      if (candidate.localToken === localToken) {
        upstreamTokenToDelete = upstreamToken;
        break;
      }
    }
    if (upstreamTokenToDelete === null) {
      return;
    }

    this.upstreamToOwned.delete(upstreamTokenToDelete);

    if (!notifyUpstream) {
      return;
    }

    this.upstream?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: `broker-release:${this.requestCounter.toString(36)}`,
        method: owned.releaseMethod,
        params: [upstreamTokenToDelete],
      }),
    );
    this.requestCounter += 1;
  }

  private disconnectUpstream(): void {
    this.pending.clear();
    this.localToOwned.clear();
    this.upstreamToOwned.clear();
    this.upstream?.disconnect();
    this.upstream = null;
  }
}

export function createChainBrokerManager(
  createProvider: (genesisHash: string) => JsonRpcProvider | null,
): ChainBrokerManager {
  const brokers = new Map<string, ChainBroker>();
  let localConnectionCounter = 0;

  function getBroker(genesisHash: string): ChainBroker | null {
    let broker = brokers.get(genesisHash);
    if (broker) {
      return broker;
    }

    const provider = createProvider(genesisHash);
    if (provider === null) {
      return null;
    }

    broker = new ChainBroker(provider, () => {
      brokers.delete(genesisHash);
    });
    brokers.set(genesisHash, broker);
    return broker;
  }

  return {
    connectRemote(genesisHash, connectionId, onMessage) {
      const broker = getBroker(genesisHash);
      return broker?.connect(connectionId, onMessage) ?? null;
    },
    getLocalProvider(genesisHash) {
      const broker = getBroker(genesisHash);
      if (!broker) {
        return null;
      }

      return (onMessage) => {
        const connectionId = `local:${localConnectionCounter.toString(36)}`;
        localConnectionCounter += 1;
        return broker.connect(connectionId, onMessage);
      };
    },
    disconnectAll() {
      for (const broker of brokers.values()) {
        broker.disconnectAll();
      }
      brokers.clear();
    },
  };
}
