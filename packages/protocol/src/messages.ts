export interface ProtocolRequestMap {
  warmup: Record<string, never>;
  resolveDotName: { label: string };
  resolveOwner: { label: string };
  authHasSession: { siteId: string };
  authStorageRead: { siteId: string; key: string };
  authStorageWrite: { siteId: string; key: string; value: string };
  authStorageClear: { siteId: string; key: string };
  chainConnect: { genesisHash: string; connectionId: string };
  chainSend: { connectionId: string; message: string };
  chainDisconnect: { connectionId: string };
}

export type ProtocolRequestMethod = keyof ProtocolRequestMap;

export interface ProtocolRequestEnvelope<
  M extends ProtocolRequestMethod = ProtocolRequestMethod,
> {
  namespace: "dotli:protocol";
  kind: "request";
  id: string;
  method: M;
  payload: ProtocolRequestMap[M];
}

export interface ProtocolProgressEnvelope {
  namespace: "dotli:protocol";
  kind: "progress";
  id: string;
  message: string;
}

export interface ProtocolResponseEnvelope {
  namespace: "dotli:protocol";
  kind: "response";
  id: string;
  ok: true;
  result: unknown;
}

export interface ProtocolErrorEnvelope {
  namespace: "dotli:protocol";
  kind: "response";
  id: string;
  ok: false;
  error: string;
}

export interface ProtocolChainMessageEnvelope {
  namespace: "dotli:protocol";
  kind: "chain-message";
  connectionId: string;
  message: string;
}

export interface ProtocolChainHaltEnvelope {
  namespace: "dotli:protocol";
  kind: "chain-halt";
  connectionId: string;
}

export interface ProtocolReadyEnvelope {
  namespace: "dotli:protocol";
  kind: "ready";
}

// Unsolicited notification from the host iframe to its parent window when a
// sibling tab writes or clears a shared-auth storage key. Drives cross-tab
// `StorageAdapter.subscribe` callbacks — see `@dotli/protocol/client`
// `subscribeSharedAuthStorage` and `apps/protocol/src/main.ts`'s
// BroadcastChannel relay.
export interface ProtocolAuthStorageChangedEnvelope {
  namespace: "dotli:protocol";
  kind: "auth-storage-changed";
  siteId: string;
  key: string;
  value: string | null;
}

export type ProtocolEnvelope =
  | ProtocolRequestEnvelope
  | ProtocolProgressEnvelope
  | ProtocolResponseEnvelope
  | ProtocolErrorEnvelope
  | ProtocolChainMessageEnvelope
  | ProtocolChainHaltEnvelope
  | ProtocolReadyEnvelope
  | ProtocolAuthStorageChangedEnvelope;

const VALID_KINDS = new Set([
  "request",
  "response",
  "progress",
  "chain-message",
  "chain-halt",
  "ready",
  "auth-storage-changed",
]);

export function isProtocolEnvelope(value: unknown): value is ProtocolEnvelope {
  if (
    typeof value !== "object" ||
    value === null ||
    !("namespace" in value) ||
    !("kind" in value)
  ) {
    return false;
  }
  const obj = value as { namespace?: unknown; kind?: unknown };
  return (
    obj.namespace === "dotli:protocol" && VALID_KINDS.has(obj.kind as string)
  );
}
