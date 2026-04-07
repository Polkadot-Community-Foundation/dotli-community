// dot.li — Protocol SharedWorker
//
// Runs smoldot directly on the SharedWorker thread using `start()` from
// `polkadot-api/smoldot` (no sub-Worker needed — `Worker` constructor is
// not available in SharedWorkerGlobalScope).
//
// All protocol iframes (across all tabs) connect via MessagePort.
// Smoldot persists as long as at least one tab is open.

/// <reference lib="webworker" />
declare const self: SharedWorkerGlobalScope;

import * as Sentry from "@sentry/browser";
import type { JsonRpcConnection } from "@polkadot-api/json-rpc-provider";
import { MAX_CONNECTIONS_PER_ORIGIN } from "@dotli/config/config";
import { createChainProvider, isChainSupported } from "@dotli/resolver/chains";
import {
  getRelayChain,
  getSmoldotDirect,
  resolveDotName,
  resolveOwner,
} from "@dotli/resolver/resolve";
import {
  releaseResolverAssetHubChain,
  terminateSmoldot,
} from "@dotli/resolver/smoldot";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import { createChainBrokerManager } from "@dotli/protocol/broker";
import { serializeError } from "@dotli/shared/errors";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN_WORKER as string | undefined,
  tunnel: "/t/worker",
  environment:
    (import.meta.env.VITE_APP_ENV as string | undefined) ?? "development",
  release: import.meta.env.VITE_COMMIT_SHA as string | undefined,
  sendDefaultPii: false,
});

m.bind(Sentry as unknown as Parameters<typeof m.bind>[0]);
import type {
  ProtocolRequestEnvelope,
  ProtocolRequestMap,
  ProtocolEnvelope,
} from "@dotli/protocol/messages";

// ── Types for iframe ↔ SharedWorker communication ────────────

export interface SWRelayRequest {
  type: "relay-request";
  envelope: ProtocolRequestEnvelope;
  origin: string;
}

export interface SWRelayResponse {
  type: "relay-response";
  envelope: ProtocolEnvelope;
}

export interface SWReady {
  type: "ready";
}

export interface SWError {
  type: "error";
  message: string;
}

export type SWInbound = SWRelayRequest;
export type SWOutbound = SWRelayResponse | SWReady | SWError;

// ── Logging (console.warn since `log` may rely on window) ────

const TAG = "[dot.li SW]";

function swLog(...args: unknown[]): void {
  console.warn(TAG, ...args);
}

function swError(...args: unknown[]): void {
  console.error(TAG, ...args);
}

// ── Engine state ─────────────────────────────────────────────

const MAX_CHAIN_CONNECTIONS = 10;
const chainConnections = new Map<string, JsonRpcConnection>();
const originConnections = new Map<string, Set<string>>();
const connectionPorts = new Map<string, MessagePort>();
const ports = new Set<MessagePort>();
const pendingPorts: MessagePort[] = [];
let engineReady = false;
let resolverChainReleased = false;

// Placeholder — set after pre-sync
let chainBrokerManager: ReturnType<typeof createChainBrokerManager>;

// ── Pre-sync: boot smoldot and wait for chain sync before accepting requests ──

const MAX_PRESYNC_RETRIES = 3;

async function presync(): Promise<void> {
  for (let attempt = 1; attempt <= MAX_PRESYNC_RETRIES; attempt++) {
    const t0 = performance.now();
    swLog(
      `Pre-sync attempt ${String(attempt)}/${String(MAX_PRESYNC_RETRIES)}...`,
    );
    m.gauge(S.SMOLDOT_PRESYNC_ATTEMPTS, attempt);

    try {
      // 1. Create smoldot (current thread, no Worker needed)
      swLog("Creating smoldot via getSmoldotDirect()...");
      getSmoldotDirect();
      m.measure(S.SMOLDOT_CREATE, performance.now() - t0);
      swLog(
        `Smoldot client created (${String(Math.round(performance.now() - t0))}ms)`,
      );

      // 2. Add relay chain
      swLog("Adding relay chain...");
      const relayT0 = performance.now();
      await getRelayChain();
      m.measure(S.SMOLDOT_RELAY_CHAIN, performance.now() - relayT0);
      swLog(
        `Relay chain added (${String(Math.round(performance.now() - t0))}ms)`,
      );

      // 3. Wait for Asset Hub to sync to a finalized block.
      // The resolver uses its own chain (getResolverAssetHubChain singleton).
      // We do NOT set a provider override — the resolver creates its chain
      // directly via getResolverAssetHubProvider().
      swLog("Waiting for Asset Hub to reach finalized block...");
      await resolveDotName("__presync__", (msg) => {
        swLog(`Pre-sync status: ${msg}`);
      });
      const totalMs = performance.now() - t0;
      m.measure(S.SMOLDOT_PRESYNC, totalMs);
      m.distribution(S.SMOLDOT_PRESYNC, totalMs);
      swLog(`Asset Hub synced (${String(Math.round(totalMs))}ms total)`);

      // 4. Create the broker. The resolver's Asset Hub chain is released
      // lazily on the first dApp chainConnect (see handleRequest below),
      // NOT here — the host still needs it for resolveDotName/resolveOwner.
      chainBrokerManager = createChainBrokerManager(createChainProvider);

      // 5. Success — mark ready
      swLog("Pre-sync complete, engine ready");
      engineReady = true;

      // Signal ready to any ports that connected during pre-sync
      for (const port of pendingPorts) {
        const readyMsg: SWReady = { type: "ready" };
        port.postMessage(readyMsg);
      }
      pendingPorts.length = 0;
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      swError(`Pre-sync attempt ${String(attempt)} failed: ${msg}`);
      m.count(S.SMOLDOT_PRESYNC_FAILURE, { attempt: String(attempt) });

      if (attempt < MAX_PRESYNC_RETRIES) {
        // Terminate and restart smoldot for a clean retry
        swLog("Terminating smoldot for clean retry...");
        try {
          terminateSmoldot();
        } catch {
          /* already dead */
        }
        // Brief pause before retry
        await new Promise<void>((r) => setTimeout(r, 2000));
      }
    }
  }

  // All retries exhausted — signal error to waiting ports
  swError(`Pre-sync failed after ${String(MAX_PRESYNC_RETRIES)} attempts`);
  m.count(S.SMOLDOT_PRESYNC_FAILURE, { attempt: "exhausted" });
  for (const port of pendingPorts) {
    const errorMsg: SWError = {
      type: "error",
      message: "Smoldot failed to sync after multiple attempts",
    };
    port.postMessage(errorMsg);
  }
  pendingPorts.length = 0;
}

// ── Helpers ──────────────────────────────────────────────────

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${name}: expected non-empty string`);
  }
}

function sendToPort(port: MessagePort, envelope: ProtocolEnvelope): void {
  try {
    const msg: SWRelayResponse = { type: "relay-response", envelope };
    port.postMessage(msg);
  } catch {
    swLog("Port disconnected, cleaning up");
    removePort(port);
  }
}

function removePort(port: MessagePort): void {
  ports.delete(port);
  let cleaned = 0;
  for (const [connId, connPort] of connectionPorts) {
    if (connPort === port) {
      const connection = chainConnections.get(connId);
      connection?.disconnect();
      chainConnections.delete(connId);
      connectionPorts.delete(connId);
      for (const [orig, conns] of originConnections) {
        conns.delete(connId);
        if (conns.size === 0) {
          originConnections.delete(orig);
        }
      }
      cleaned++;
    }
  }
  swLog(
    `Port removed (cleaned ${String(cleaned)} connections, ${String(ports.size)} ports remaining)`,
  );
}

// ── Request handling ─────────────────────────────────────────

async function handleRequest(
  port: MessagePort,
  request: ProtocolRequestEnvelope,
  origin: string,
): Promise<void> {
  const t = performance.now();

  switch (request.method) {
    case "warmup": {
      // Pre-sync already started smoldot + relay chain + periodic saves.
      // Just confirm it's done.
      swLog(
        `Warmup acknowledged (engine already pre-synced) (${String(Math.round(performance.now() - t))}ms)`,
      );
      sendToPort(port, {
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
        sendToPort(port, {
          namespace: "dotli:protocol",
          kind: "progress",
          id: request.id,
          message,
        });
      });
      swLog(
        `Resolved "${payload.label}" → ${result ?? "null"} (${String(Math.round(performance.now() - t))}ms)`,
      );
      sendToPort(port, {
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
      swLog(
        `Owner "${payload.label}" → ${result ?? "null"} (${String(Math.round(performance.now() - t))}ms)`,
      );
      sendToPort(port, {
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
      const originConns = originConnections.get(origin) ?? new Set<string>();
      if (originConns.size >= MAX_CONNECTIONS_PER_ORIGIN) {
        throw new Error(
          `Per-origin connection limit reached (max ${String(MAX_CONNECTIONS_PER_ORIGIN)})`,
        );
      }
      if (!isChainSupported(payload.genesisHash)) {
        throw new Error(`Unsupported chain: ${payload.genesisHash}`);
      }
      // Release the resolver's Asset Hub chain on the first dApp connection.
      // By this point the host has already resolved the CID. Releasing frees
      // the chain so the dApp gets a FRESH chain with no "announced blocks"
      // history (avoids smoldot's per-connection block deduplication).
      if (!resolverChainReleased) {
        resolverChainReleased = true;
        swLog(
          "First dApp chain connection — releasing resolver Asset Hub chain",
        );
        releaseResolverAssetHubChain();
      }
      let chainMsgCount = 0;
      const connection = chainBrokerManager.connectRemote(
        payload.genesisHash,
        payload.connectionId,
        (message) => {
          chainMsgCount++;
          if (chainMsgCount <= 5 || chainMsgCount % 100 === 0) {
            swLog(
              `Chain message #${String(chainMsgCount)} for ${payload.connectionId} (${String(message.length)} bytes)`,
            );
          }
          sendToPort(port, {
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
      chainConnections.set(payload.connectionId, connection);
      connectionPorts.set(payload.connectionId, port);
      originConns.add(payload.connectionId);
      originConnections.set(origin, originConns);
      swLog(
        `Chain connected: ${payload.connectionId} (${String(chainConnections.size)} total)`,
      );
      sendToPort(port, {
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
      const connection = chainConnections.get(payload.connectionId);
      if (connection === undefined) {
        throw new Error(`Unknown chain connection: ${payload.connectionId}`);
      }
      connection.send(payload.message);
      sendToPort(port, {
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
      const connection = chainConnections.get(payload.connectionId);
      connection?.disconnect();
      chainConnections.delete(payload.connectionId);
      connectionPorts.delete(payload.connectionId);
      for (const [orig, conns] of originConnections) {
        conns.delete(payload.connectionId);
        if (conns.size === 0) {
          originConnections.delete(orig);
        }
      }
      swLog(
        `Chain disconnected: ${payload.connectionId} (${String(chainConnections.size)} remaining)`,
      );
      sendToPort(port, {
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

// ── SharedWorker lifecycle ───────────────────────────────────

// Proactively clean up stale ports by sending a ping.
// Posting to a closed port throws — we catch that to detect dead ports.
function cleanStalePorts(): void {
  for (const p of [...ports]) {
    try {
      p.postMessage({ type: "ping" });
    } catch {
      swLog("Detected stale port during cleanup");
      removePort(p);
    }
  }
}

self.addEventListener("connect", (event) => {
  const port = event.ports[0];

  // Clean up any stale ports from previous iframe reloads
  cleanStalePorts();

  ports.add(port);
  swLog(
    `Port connected (${String(ports.size)} total, engine ${engineReady ? "ready" : "syncing"})`,
  );

  port.addEventListener("message", (msgEvent: MessageEvent) => {
    const data = msgEvent.data as { type?: string } | null;

    // Handle disconnect signal from iframe beforeunload
    if (data?.type === "disconnect") {
      swLog("Port sent disconnect signal, cleaning up");
      removePort(port);
      return;
    }

    if (data?.type !== "relay-request") {
      return;
    }

    const relayData = data as SWRelayRequest;
    const { envelope, origin } = relayData;
    void handleRequest(port, envelope, origin).catch((error: unknown) => {
      const msg = serializeError(error);
      swError(`Request ${envelope.method} failed:`, msg);
      sendToPort(port, {
        namespace: "dotli:protocol",
        kind: "response",
        id: envelope.id,
        ok: false,
        error: msg,
      });
    });
  });

  port.start();

  if (engineReady) {
    // Engine already synced — signal ready immediately
    const readyMsg: SWReady = { type: "ready" };
    port.postMessage(readyMsg);
  } else {
    // Engine still syncing — queue port, will signal when pre-sync completes
    swLog("Engine not ready yet, queuing port for ready signal");
    pendingPorts.push(port);
  }
});

swLog("SharedWorker initialized, starting pre-sync...");
void presync();
