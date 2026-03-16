// dot.li — Smoldot lifecycle management
//
// Shared smoldot instance and relay chain, reused by resolve.ts and chains.ts.
// Handles smoldot startup, relay chain creation, and database persistence.

import { startFromWorker } from "polkadot-api/smoldot/from-worker";
import SmWorker from "polkadot-api/smoldot/worker?worker";
import { getPaseoChainSpec } from "./chain-specs";
import { loadChainDb, extractAndSaveChainDb } from "./db";
import { FINALIZED_DB_MAX_SIZE } from "./config";
import { log } from "./log";

export type SmoldotChain = Awaited<
  ReturnType<ReturnType<typeof startFromWorker>["addChain"]>
>;

/**
 * Extract the relay chain database via JSON-RPC and save to IndexedDB.
 * The relay chain's JSON-RPC is free (not consumed by any provider).
 */
export async function extractAndSaveRelayDb(
  relayChain: SmoldotChain,
): Promise<void> {
  await extractAndSaveChainDb(
    relayChain,
    FINALIZED_DB_MAX_SIZE,
    log.warn,
    "[dot.li smoldot]",
  );
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
      log.warn(
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
