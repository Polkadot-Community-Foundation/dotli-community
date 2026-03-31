// dot.li — Smoldot lifecycle management
//
// Shared smoldot instance and relay chain, reused by resolve.ts and chains.ts.
// Handles smoldot startup, relay chain creation, and database persistence.
//
// Two Asset Hub chains exist at different lifecycle stages:
//   1. Resolver chain — temporary, created for name resolution, destroyed after
//   2. Shared chain  — long-lived singleton for dApp chain connections
// smoldot panics if the same chain is added twice, so a mutex ensures
// the resolver chain is fully removed before the shared chain is created.

import { startFromWorker } from "polkadot-api/smoldot/from-worker";
import SmWorker from "polkadot-api/smoldot/worker?worker";
import {
  getPaseoChainSpec,
  getAssetHubPaseoChainSpec,
  getBulletinPaseoChainSpec,
} from "./chain-specs";
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

// ── Temporary Asset Hub chain for the resolver ───────────────
// The resolver creates its own chain that is destroyed after resolution.
// This avoids sharing nextJsonRpcResponse() between the resolver's
// polkadot-api client and dApp chain connections (message theft).

/**
 * Create a temporary Asset Hub Paseo chain for the resolver.
 * The caller MUST call chain.remove() when done (via destroyClient).
 * Must NOT be called after the shared chain exists (smoldot panics).
 */
export async function createResolverAssetHubChain(): Promise<SmoldotChain> {
  resolverChainCreated = true;
  if (mutexReleased) {
    throw new Error(
      "Cannot create resolver chain: shared chain may already exist",
    );
  }
  const [relayChain, chainSpec] = await Promise.all([
    getRelayChain(),
    getAssetHubPaseoChainSpec(),
  ]);
  return getSmoldot().addChain({
    chainSpec,
    potentialRelayChains: [relayChain],
  });
}

// ── Bulletin Paseo chain (for preimage operations) ───────────
// Long-lived singleton — no mutex conflict with Asset Hub.

let bulletinChainPromise: Promise<SmoldotChain> | null = null;

/**
 * Get or create the Bulletin Paseo parachain singleton.
 * Used for preimage submission via TransactionStorage.
 */
export function getBulletinChain(): Promise<SmoldotChain> {
  bulletinChainPromise ??= Promise.all([
    getRelayChain(),
    getBulletinPaseoChainSpec(),
  ]).then(([relayChain, chainSpec]) =>
    getSmoldot().addChain({
      chainSpec,
      potentialRelayChains: [relayChain],
    }),
  );
  return bulletinChainPromise;
}

// ── Shared Asset Hub Paseo chain (for dApp connections) ──────
// Created lazily after the resolver releases the mutex.

let assetHubChainPromise: Promise<SmoldotChain> | null = null;

/**
 * Get or create the Asset Hub Paseo parachain singleton.
 * Only available after the resolver mutex is released.
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

// ── Resolver mutex ───────────────────────────────────────────
// Ensures the resolver chain is fully removed before the shared
// chain is created (smoldot panics on duplicate chains).
// If no resolver chain is ever created (e.g. localhost mode),
// waitForResolverRelease() resolves immediately.

let resolverChainCreated = false;
let mutexReleased = false;
let resolverRelease: () => void;
const resolverDone: Promise<void> = new Promise<void>((r) => {
  resolverRelease = r;
});

/**
 * Release the resolver mutex.
 * Called after the resolver's dedicated chain is destroyed.
 */
export function releaseResolverMutex(): void {
  mutexReleased = true;
  resolverRelease();
}

/**
 * Wait until the resolver has released the Asset Hub chain.
 * Resolves immediately if no resolver chain was ever created.
 */
export function waitForResolverRelease(): Promise<void> {
  if (!resolverChainCreated) {
    return Promise.resolve();
  }
  return resolverDone;
}

/**
 * Whether the resolver mutex has been released (shared chain may exist).
 */
export function isResolverDone(): boolean {
  return mutexReleased;
}
