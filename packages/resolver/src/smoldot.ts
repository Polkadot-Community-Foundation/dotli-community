// dot.li — Smoldot lifecycle management
//
// Shared smoldot instance and relay chain, reused by resolve.ts and chains.ts.
// Handles smoldot startup, relay chain creation, and database persistence.

import { startFromWorker } from "polkadot-api/smoldot/from-worker";
import SmWorker from "polkadot-api/smoldot/worker?worker";
import { getPaseoChainSpec, getAssetHubPaseoChainSpec } from "./chain-specs";
import { loadChainDb, extractAndSaveChainDb } from "@dotli/storage/db";
import { FINALIZED_DB_MAX_SIZE } from "@dotli/config/config";
import { log } from "@dotli/shared/log";

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

// ── Dedicated Asset Hub chain for the resolver ───────────────
// The resolver creates its own temporary chain that is fully removed
// when resolution completes. This avoids sharing a single
// nextJsonRpcResponse() queue between the resolver and chains.ts,
// which would cause message theft and polkadot-api block-tree crashes.
//
// Smoldot panics if the same parachain is added twice, so the resolver
// must fully remove its chain before chains.ts creates the singleton.
// The sequential-use mutex below enforces this ordering.

/**
 * Create a dedicated Asset Hub Paseo chain for the resolver.
 * The caller owns this chain and MUST call chain.remove() when done
 * (which happens automatically via clientInstance.destroy()).
 */
export async function createResolverAssetHubChain(): Promise<SmoldotChain> {
  const [relayChain, chainSpec] = await Promise.all([
    getRelayChain(),
    getAssetHubPaseoChainSpec(),
  ]);
  return getSmoldot().addChain({
    chainSpec,
    potentialRelayChains: [relayChain],
  });
}

// ── Shared Asset Hub Paseo chain (for chains.ts) ─────────────
// Created lazily, only after the resolver's dedicated chain is removed.
// Used by chains.ts to serve embedded app connections.

let assetHubChainPromise: Promise<SmoldotChain> | null = null;

/**
 * Get or create the Asset Hub Paseo parachain singleton.
 * Must only be called after the resolver has released the mutex
 * (i.e., after its dedicated chain has been removed).
 */
export function getAssetHubChain(): Promise<SmoldotChain> {
  assetHubChainPromise ??= Promise.all([
    getRelayChain(),
    getAssetHubPaseoChainSpec(),
  ]).then(([relayChain, chainSpec]) =>
    getSmoldot().addChain({
      chainSpec,
      potentialRelayChains: [relayChain],
    }),
  );
  return assetHubChainPromise;
}

/**
 * Wrap a chain so that remove() is a no-op.
 * Use when passing a shared singleton to getSmProvider() so that
 * polkadot-api's client.destroy() doesn't kill the shared chain.
 */
export function makeNonRemovingChain(chain: SmoldotChain): SmoldotChain {
  return {
    sendJsonRpc: chain.sendJsonRpc.bind(chain),
    nextJsonRpcResponse: chain.nextJsonRpcResponse.bind(chain),
    jsonRpcResponses: chain.jsonRpcResponses,
    remove: () => {
      /* intentional no-op: chain is a shared singleton */
    },
  };
}

// ── Sequential-use mutex ─────────────────────────────────────
// The resolver owns a dedicated Asset Hub chain during resolution.
// chains.ts must wait for the resolver to destroy its chain before
// creating the shared singleton — smoldot panics on double-addChain.
//
// Starts LOCKED so that even in the fast-path (CID cache hit),
// chains.ts waits for the resolver to finish.
//
// ONE-SHOT: This mutex can only be released once per page load.
// If multiple resolution cycles are needed (e.g., SPA navigation
// to a second .dot domain), the page must be fully reloaded.
//
// SYNCHRONOUS REMOVE: Correctness depends on polkadot-api's
// client.destroy() calling chain.remove() synchronously before
// releaseResolverMutex() fires. Verified: createClient().destroy()
// → substrate-client disconnect → getSyncProvider disconnect
// → sm-provider disconnect() → chain.remove() — all synchronous.

let resolverRelease: () => void;
const resolverDone: Promise<void> = new Promise<void>((r) => {
  resolverRelease = r;
});

/**
 * Release the resolver mutex.
 * Called by resolve.ts after destroying its dedicated chain.
 */
export function releaseResolverMutex(): void {
  resolverRelease();
}

/**
 * Wait until the resolver has released the Asset Hub chain.
 * Blocks until releaseResolverMutex() is called.
 */
export function waitForResolverRelease(): Promise<void> {
  return resolverDone;
}
