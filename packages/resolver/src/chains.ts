// dot.li — Chain provider factory
//
// Maps well-known genesis hashes to smoldot chain specs and creates
// JsonRpcProviders on demand. Used by the host container to serve
// chain connections to SPAs via handleChainConnection.

import { getPaseoChainSpec, getAssetHubPaseoChainSpec } from "./chain-specs";
import { getSmProvider } from "polkadot-api/sm-provider";
import type { JsonRpcProvider } from "@polkadot-api/json-rpc-provider";
import {
  PASEO_RELAY_GENESIS as PASEO_RELAY,
  ASSET_HUB_PASEO_GENESIS as ASSET_HUB_PASEO,
} from "@dotli/config/config";

import {
  getSmoldot,
  getRelayChain,
  getAssetHubChain,
  makeNonRemovingChain,
  waitForResolverRelease,
} from "./smoldot";

interface ChainEntry {
  getChainSpec: () => Promise<string>;
  isParachain: boolean;
}

const SUPPORTED_CHAINS: Record<string, ChainEntry> = {
  [PASEO_RELAY]: { getChainSpec: getPaseoChainSpec, isParachain: false },
  [ASSET_HUB_PASEO]: {
    getChainSpec: getAssetHubPaseoChainSpec,
    isParachain: true,
  },
};

// Cache: genesis hash → provider (created once per chain)
const providerCache = new Map<string, JsonRpcProvider>();

/**
 * Check if a genesis hash corresponds to a supported chain.
 */
export function isChainSupported(genesisHash: string): boolean {
  return genesisHash.toLowerCase() in SUPPORTED_CHAINS;
}

/**
 * Create a JsonRpcProvider for a given genesis hash.
 * Returns null if the chain is not supported.
 * Providers are cached — each chain is added to smoldot only once.
 */
export function createChainProvider(
  genesisHash: string,
): JsonRpcProvider | null {
  const key = genesisHash.toLowerCase();
  const entry = SUPPORTED_CHAINS[key] as ChainEntry | undefined;
  if (entry === undefined) {
    return null;
  }

  const cached = providerCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  let chainPromise: Promise<ReturnType<typeof makeNonRemovingChain>>;

  if (key === ASSET_HUB_PASEO.toLowerCase()) {
    // Reuse the shared singleton; wait for resolver to finish first.
    // The resolver uses a dedicated chain that is fully removed before
    // this runs, so no stale messages — just wrap to prevent removal.
    chainPromise = waitForResolverRelease().then(() =>
      getAssetHubChain().then(makeNonRemovingChain),
    );
  } else if (key === PASEO_RELAY.toLowerCase()) {
    // Reuse the shared relay chain singleton
    chainPromise = getRelayChain().then(makeNonRemovingChain);
  } else if (entry.isParachain) {
    const smoldot = getSmoldot();
    chainPromise = Promise.all([getRelayChain(), entry.getChainSpec()]).then(
      ([relayChain, chainSpec]) =>
        smoldot.addChain({
          chainSpec,
          potentialRelayChains: [relayChain],
        }),
    );
  } else {
    const smoldot = getSmoldot();
    chainPromise = entry
      .getChainSpec()
      .then((chainSpec) => smoldot.addChain({ chainSpec }));
  }

  const provider = getSmProvider(chainPromise);
  providerCache.set(key, provider);
  return provider;
}
