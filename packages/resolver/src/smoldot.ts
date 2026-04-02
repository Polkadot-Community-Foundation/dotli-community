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
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";

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
  assetHubProvider = null;
}

export function getRelayChain(): Promise<SmoldotChain> {
  relayChainPromise ??= getPaseoChainSpec()
    .then((chainSpec) => {
      log.warn("[dot.li smoldot] Adding relay chain...");
      m.breadcrumb("Adding relay chain");
      return getSmoldot().addChain({ chainSpec });
    })
    .catch((error: unknown) => {
      relayChainPromise = null;
      m.count(S.BOOTNODE_ERROR, { chain: "relay" });
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
let assetHubProvider: JsonRpcProvider | null = null;
let resolverAssetHubProviderOverride: JsonRpcProvider | null = null;

function createAssetHubChain(
  relay: Promise<SmoldotChain>,
): Promise<SmoldotChain> {
  const t0 = performance.now();
  return Promise.all([relay, getAssetHubPaseoChainSpec()])
    .then(([relayChain, chainSpec]) => {
      log.warn("[dot.li smoldot] Adding Asset Hub parachain...");
      m.breadcrumb("Adding Asset Hub parachain");
      return getSmoldot().addChain({
        chainSpec,
        potentialRelayChains: [relayChain],
      });
    })
    .then((chain) => {
      m.measure(S.SMOLDOT_ASSET_HUB, performance.now() - t0);
      m.distribution(S.SMOLDOT_ASSET_HUB, performance.now() - t0);
      return chain;
    })
    .catch((error: unknown) => {
      m.count(S.BOOTNODE_ERROR, { chain: "asset_hub" });
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
  assetHubProvider ??= getSmProvider(getResolverAssetHubChain());
  return assetHubProvider;
}

/**
 * Return the direct smoldot provider for the shared Asset Hub chain.
 *
 * `@polkadot-api/sm-provider` expects exclusive ownership of a chain's
 * JSON-RPC response stream, so multiple providers must not share the
 * same smoldot chain. The broker multiplexes this single upstream
 * provider into isolated sessions for remote clients.
 */
export function getSharedAssetHubProvider(): JsonRpcProvider {
  assetHubProvider ??= getSmProvider(getResolverAssetHubChain());
  return assetHubProvider;
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

// ── dApp Asset Hub chain (fresh, no shared history) ─────────────
//
// After the resolver finishes dotNS resolution, its chain can be released.
// dApp connections then use a FRESH chain that has no "announced blocks"
// history, avoiding smoldot's per-connection block deduplication.

let dappAssetHubPromise: Promise<SmoldotChain> | null = null;

/**
 * Release the resolver's Asset Hub chain so a fresh chain can be created
 * for dApp connections. After calling this, the resolver's polkadot-api
 * client is no longer usable (CID is already cached).
 */
export function releaseResolverAssetHubChain(): void {
  if (resolverAssetHubPromise === null) {
    return;
  }
  log.warn("[dot.li smoldot] Releasing resolver Asset Hub chain");
  void resolverAssetHubPromise
    .then((chain) => {
      chain.remove();
      log.warn("[dot.li smoldot] Resolver Asset Hub chain removed");
    })
    .catch(() => {
      /* already dead or not yet created */
    });
  resolverAssetHubPromise = null;
  assetHubProvider = null;
  resolverAssetHubProviderOverride = null;
}

/**
 * Get or create a fresh Asset Hub chain for dApp connections.
 *
 * This chain is separate from the resolver's chain and has no
 * "announced blocks" history — smoldot will send complete newBlock
 * events for all non-finalized blocks on new subscriptions.
 */
export function getDappAssetHubChain(): Promise<SmoldotChain> {
  dappAssetHubPromise ??= createAssetHubChain(getRelayChain()).catch(
    (error: unknown) => {
      dappAssetHubPromise = null;
      throw error;
    },
  );
  return dappAssetHubPromise;
}

/**
 * Return a provider backed by the dApp's fresh Asset Hub chain.
 * Used by `createChainProvider()` for remote dApp connections.
 */
export function getDappAssetHubProvider(): JsonRpcProvider {
  return getSmProvider(getDappAssetHubChain());
}
