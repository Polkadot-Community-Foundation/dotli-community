// dot.li — Smoldot lifecycle management
//
// Shared smoldot instance and relay chain, reused by resolve.ts and chains.ts.
// Handles smoldot startup, relay chain creation, and database persistence.

import { startFromWorker } from "polkadot-api/smoldot/from-worker";
import SmWorker from "polkadot-api/smoldot/worker?worker";
import { getPaseoChainSpec } from "./chain-specs";
import { loadChainDb, saveChainDb } from "./db";
import { FINALIZED_DB_MAX_SIZE } from "./config";

export type SmoldotChain = Awaited<
  ReturnType<ReturnType<typeof startFromWorker>["addChain"]>
>;

// ── Smoldot database persistence (IndexedDB) ────────────────
// Persisting the relay chain DB lets smoldot resume from its last
// known state instead of syncing from the bundled lightSyncState,
// reducing sync time from ~10s to ~1-3s on revisits.

let dbSaveId = 0;

/**
 * Extract the relay chain database via JSON-RPC and save to IndexedDB.
 * The relay chain's JSON-RPC is free (not consumed by any provider).
 */
export async function extractAndSaveRelayDb(
  relayChain: SmoldotChain,
): Promise<void> {
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
        `[dot.li smoldot] Saved relay chain DB (${String(Math.round(resp.result.length / 1024))} KB)`,
      );
    }
  } catch {
    // Non-critical — DB persistence failure doesn't affect functionality
  }
}

// ── Shared smoldot instance and relay chain ──────────────────

let smoldotInstance: ReturnType<typeof startFromWorker> | null = null;
let relayChainPromise: Promise<SmoldotChain> | null = null;

/**
 * Get or create the shared smoldot instance.
 */
export function getSmoldot(): ReturnType<typeof startFromWorker> {
  smoldotInstance ??= startFromWorker(new SmWorker(), {
    maxLogLevel: import.meta.env.DEV ? 3 : 1,
  });
  return smoldotInstance;
}

/**
 * Get or create the Paseo relay chain (needed as potentialRelayChain for parachains).
 * Restores from IndexedDB-persisted database if available, dramatically
 * reducing sync time on revisits (~10s → ~1-3s).
 */
export function getRelayChain(): Promise<SmoldotChain> {
  relayChainPromise ??= Promise.all([
    loadChainDb("paseo"),
    getPaseoChainSpec(),
  ]).then(([dbContent, chainSpec]) => {
    if (dbContent !== undefined) {
      console.warn(
        `[dot.li smoldot] Restored relay chain DB (${String(Math.round(dbContent.length / 1024))} KB)`,
      );
    }
    return getSmoldot().addChain({
      chainSpec,
      databaseContent: dbContent,
    });
  });
  return relayChainPromise;
}
