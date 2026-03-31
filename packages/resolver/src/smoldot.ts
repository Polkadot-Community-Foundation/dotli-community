// dot.li — Smoldot lifecycle management
//
// Single shared smoldot instance plus a small set of provider factories.
// The protocol host can override the resolver's Asset Hub provider so
// `.dot` resolution and remote dApp clients share one upstream JSON-RPC
// loop through a broker.
//
// Chain DB persistence is handled by smoldot internally — we do NOT
// manually save/load chain databases to IndexedDB.

import { start as startSmoldotDirect } from "polkadot-api/smoldot";
import { startFromWorker } from "polkadot-api/smoldot/from-worker";
import SmWorker from "polkadot-api/smoldot/worker?worker";
import { getSmProvider } from "polkadot-api/sm-provider";
import type { JsonRpcProvider } from "@polkadot-api/json-rpc-provider";
import {
  getPaseoChainSpec,
  getAssetHubPaseoChainSpec,
  getBulletinPaseoChainSpec,
} from "./chain-specs";
import { log } from "@dotli/shared/log";

/** The smoldot Client type (shared by `start()` and `startFromWorker()`). */
export type SmoldotClient = ReturnType<typeof startFromWorker>;

export type SmoldotChain = Awaited<ReturnType<SmoldotClient["addChain"]>>;

// ── Shared smoldot instance ──────────────────────────────────

let smoldotInstance: SmoldotClient | null = null;
let relayChainPromise: Promise<SmoldotChain> | null = null;

/**
 * Create smoldot using `start()` — runs on the current thread.
 *
 * Used in SharedWorker context where the `Worker` constructor is unavailable.
 * Smoldot networking (WebSocket) is async; occasional CPU bursts for block
 * verification (~2-10ms per block) are acceptable on the SharedWorker thread.
 */
export function getSmoldotDirect(): SmoldotClient {
  if (smoldotInstance !== null) {
    return smoldotInstance;
  }
  log.warn("[dot.li smoldot] Creating smoldot via start() (current thread)");
  smoldotInstance = startSmoldotDirect({
    maxLogLevel: 1,
  });
  log.warn("[dot.li smoldot] Smoldot client ready (direct mode)");
  return smoldotInstance;
}

export function getSmoldot(): SmoldotClient {
  if (smoldotInstance !== null) {
    return smoldotInstance;
  }
  log.warn("[dot.li smoldot] Creating smoldot via startFromWorker()");
  smoldotInstance = startFromWorker(new SmWorker(), {
    maxLogLevel: import.meta.env.DEV ? 3 : 1,
  });
  return smoldotInstance;
}

export function terminateSmoldot(): void {
  if (smoldotInstance === null) {
    return;
  }
  log.warn("[dot.li smoldot] Terminating smoldot instance");
  try {
    void smoldotInstance.terminate();
  } catch {
    // Already destroyed or crashed — safe to ignore.
  }
  smoldotInstance = null;
  relayChainPromise = null;
  resolverAssetHubPromise = null;
  resolverAssetHubProvider = null;
}

export function getRelayChain(): Promise<SmoldotChain> {
  relayChainPromise ??= getPaseoChainSpec()
    .then((chainSpec) => {
      log.warn("[dot.li smoldot] Adding relay chain...");
      return getSmoldot().addChain({ chainSpec });
    })
    .catch((error: unknown) => {
      relayChainPromise = null;
      throw error;
    });
  return relayChainPromise;
}

// ── Provider factories ──────────────────────────────────────

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
/**
 * Wrap a chain so `.remove()` is a no-op.
 * Used for shared singletons (e.g. bulletin chain) where a polkadot-api
 * client must not tear down the underlying chain on disconnect.
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

// ── Dedicated provider factories ─────────────────────────────

let resolverAssetHubPromise: Promise<SmoldotChain> | null = null;
let resolverAssetHubProvider: JsonRpcProvider | null = null;
let resolverAssetHubProviderOverride: JsonRpcProvider | null = null;

function createAssetHubChain(
  relay: Promise<SmoldotChain>,
): Promise<SmoldotChain> {
  return Promise.all([relay, getAssetHubPaseoChainSpec()])
    .then(([relayChain, chainSpec]) => {
      log.warn("[dot.li smoldot] Adding Asset Hub parachain...");
      return getSmoldot().addChain({
        chainSpec,
        potentialRelayChains: [relayChain],
      });
    })
    .catch((error: unknown) => {
      throw error;
    });
}

function getResolverAssetHubChain(): Promise<SmoldotChain> {
  resolverAssetHubPromise ??= createAssetHubChain(getRelayChain()).catch(
    (error: unknown) => {
      resolverAssetHubPromise = null;
      throw error;
    },
  );
  return resolverAssetHubPromise;
}

export function getResolverAssetHubProvider(): JsonRpcProvider {
  if (resolverAssetHubProviderOverride !== null) {
    return resolverAssetHubProviderOverride;
  }
  resolverAssetHubProvider ??= getSmProvider(getResolverAssetHubChain());
  return resolverAssetHubProvider;
}

/**
 * Return a raw smoldot provider for the shared Asset Hub chain.
 *
 * Unlike `getResolverAssetHubProvider()`, this always returns a fresh
 * `getSmProvider()` instance from the shared chain — it never returns
 * the broker override. Used by `createChainProvider()` in chains.ts
 * so the broker can wrap this provider with session isolation.
 */
export function getSharedAssetHubProvider(): JsonRpcProvider {
  return getSmProvider(getResolverAssetHubChain());
}

/**
 * Override the resolver's Asset Hub provider.
 * Used by the shared protocol broker so the resolver and remote dApps
 * can share one upstream JSON-RPC loop.
 */
export function setResolverAssetHubProviderOverride(
  provider: JsonRpcProvider | null,
): void {
  resolverAssetHubProviderOverride = provider;
}
