// dot.li — Service Worker smoldot management
//
// Runs smoldot directly in the Service Worker thread using smoldot's
// start() function. Manages the relay chain + Asset Hub parachain lifecycle
// and bridges JSON-RPC to/from the main thread via MessagePort.
//
// The SW persists across navigations within the same origin, keeping
// smoldot synced and the Wasm runtime compiled — eliminating the ~10s
// cold-start sync on subsequent page loads.

import type { Client, Chain } from "smoldot";
import { TIMEOUTS, FINALIZED_DB_MAX_SIZE } from "./config";

// ── IndexedDB persistence (shared with resolve.ts via db.ts) ──

import { loadChainDb, saveChainDb } from "./db";

// ── Smoldot lifecycle ────────────────────────────────────────

let smoldotClient: Client | null = null;
let relayChain: Chain | null = null;
let assetHubChain: Chain | null = null;
let initPromise: Promise<void> | null = null;
let dbSaveId = 0;

/**
 * Extract the relay chain database via JSON-RPC and save to IndexedDB.
 */
async function extractAndSaveRelayDb(): Promise<void> {
  if (!relayChain) {
    return;
  }
  const id = ++dbSaveId;
  try {
    relayChain.sendJsonRpc(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "chainHead_unstable_finalizedDatabase",
        params: [FINALIZED_DB_MAX_SIZE],
      }),
    );
    const raw = await relayChain.nextJsonRpcResponse();
    const resp = JSON.parse(raw) as { id?: number; result?: string };
    if (resp.id === id && typeof resp.result === "string") {
      await saveChainDb("paseo", resp.result);
      console.warn(
        `[dot.li SW] Saved relay chain DB (${String(Math.round(resp.result.length / 1024))} KB)`,
      );
    }
  } catch {
    // Non-critical
  }
}

/**
 * Initialize smoldot, add relay chain + Asset Hub parachain.
 * Uses IndexedDB-persisted database for fast restarts.
 */
async function initSmoldot(): Promise<void> {
  const initStart = performance.now();
  console.warn("[dot.li SW] Starting smoldot...");

  // Dynamic imports — smoldot (~3MB WASM) and chain specs (~150KB) are loaded
  // lazily so the SW can install/activate instantly without blocking on them.
  // Chain specs are imported as raw strings directly (bypassing the fetch()-based
  // chain-specs module) since the SW build inlines all dynamic imports.
  const [
    { start },
    { default: paseoChainSpec },
    { default: assetHubPaseoChainSpec },
  ] = await Promise.all([
    import("smoldot"),
    import("./chain-specs/paseo.json?raw"),
    import("./chain-specs/asset-hub-paseo.json?raw"),
  ]);

  smoldotClient = start({ maxLogLevel: 1 });

  // Load persisted relay chain DB
  const dbContent = await loadChainDb("paseo");
  if (dbContent !== undefined) {
    console.warn(
      `[dot.li SW] Restored relay chain DB (${String(Math.round(dbContent.length / 1024))} KB)`,
    );
  }

  relayChain = await smoldotClient.addChain({
    chainSpec: paseoChainSpec,
    databaseContent: dbContent,
    disableJsonRpc: false,
  });
  console.warn(
    `[dot.li SW] Relay chain added (${String(Math.round(performance.now() - initStart))}ms)`,
  );

  assetHubChain = await smoldotClient.addChain({
    chainSpec: assetHubPaseoChainSpec,
    potentialRelayChains: [relayChain],
    disableJsonRpc: false,
  });
  console.warn(
    `[dot.li SW] Asset Hub parachain added (${String(Math.round(performance.now() - initStart))}ms)`,
  );

  // Persist relay chain DB for future fast restarts (fire-and-forget)
  // Wait a bit for the chain to sync before extracting
  setTimeout(() => {
    void extractAndSaveRelayDb();
  }, TIMEOUTS.RELAY_DB_FIRST_SAVE);

  // Also save periodically while the SW is alive
  setInterval(() => {
    void extractAndSaveRelayDb();
  }, TIMEOUTS.RELAY_DB_SAVE_INTERVAL);
}

/**
 * Ensure smoldot is initialized (idempotent).
 */
export function ensureSmoldot(): Promise<void> {
  initPromise ??= initSmoldot().catch((err: unknown) => {
    console.error("[dot.li SW] Failed to initialize smoldot:", err);
    initPromise = null;
    throw err;
  });
  return initPromise;
}

/**
 * Check if smoldot and the Asset Hub chain are ready.
 */
export function isReady(): boolean {
  return assetHubChain !== null;
}

/**
 * Handle SMOLDOT_STATUS message — reply with readiness.
 */
export function handleStatus(port: MessagePort): void {
  port.postMessage({
    type: "SMOLDOT_STATUS_REPLY",
    ready: isReady(),
  });
}

// Active connection tracking — only one main-thread client at a time.
// When a new client connects, the old port is closed and the response
// loop naturally stops dispatching to it.
let activePort: MessagePort | null = null;

/**
 * Handle SMOLDOT_CONNECT message — set up JSON-RPC bridge.
 * The main thread sends this with a MessagePort. We bridge
 * JSON-RPC between that port and the Asset Hub chain.
 *
 * Only one active connection at a time. A new connection replaces
 * the previous one (the chain and its response loop persist, but
 * responses are routed to the new port).
 */
export async function handleConnect(port: MessagePort): Promise<void> {
  try {
    await ensureSmoldot();

    if (!assetHubChain) {
      port.postMessage({
        type: "SMOLDOT_ERROR",
        error: "Asset Hub chain not available",
      });
      return;
    }

    // Replace the active port — old client is gone (page unloaded)
    if (activePort !== null) {
      try {
        activePort.close();
      } catch {
        // Already closed
      }
    }
    activePort = port;

    // Confirm connection
    port.postMessage({ type: "SMOLDOT_CONNECTED" });

    // Bridge: main thread → smoldot
    port.onmessage = (evt: MessageEvent): void => {
      const data = evt.data as { type: string; message?: string } | null;
      if (data?.type === "SMOLDOT_RPC_SEND" && data.message !== undefined) {
        try {
          assetHubChain?.sendJsonRpc(data.message);
        } catch (err) {
          port.postMessage({
            type: "SMOLDOT_ERROR",
            error: String(err),
          });
        }
      }
      if (data?.type === "SMOLDOT_DISCONNECT") {
        if (activePort === port) {
          activePort = null;
        }
        port.close();
      }
    };

    // Start the response forwarding loop if not already running
    startResponseLoop();
  } catch (err) {
    port.postMessage({
      type: "SMOLDOT_ERROR",
      error: `Init failed: ${String(err)}`,
    });
  }
}

// Single response loop that forwards responses to whichever port is active.
// This runs for the lifetime of the chain (not per-connection).
let responseLoopRunning = false;

function startResponseLoop(): void {
  if (responseLoopRunning || !assetHubChain) {
    return;
  }
  responseLoopRunning = true;

  const chain = assetHubChain;
  const loop = async (): Promise<void> => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      while (true) {
        const response = await chain.nextJsonRpcResponse();
        if (activePort !== null) {
          activePort.postMessage({
            type: "SMOLDOT_RPC_RESPONSE",
            message: response,
          });
        }
      }
    } catch {
      responseLoopRunning = false;
      // Chain removed or error — stop forwarding
      if (activePort !== null) {
        activePort.postMessage({
          type: "SMOLDOT_ERROR",
          error: "Chain response loop ended",
        });
      }
    }
  };
  void loop();
}
