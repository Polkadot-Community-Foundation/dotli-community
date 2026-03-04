// dot.li — Chain provider factory
//
// Maps well-known genesis hashes to smoldot chain specs and creates
// JsonRpcProviders on demand. Used by the host container to serve
// chain connections to SPAs via handleChainConnection.

import { chainSpec as paseoChainSpec } from "polkadot-api/chains/paseo";
import { chainSpec as assetHubPaseoChainSpec } from "polkadot-api/chains/paseo_asset_hub";
import { getSmProvider } from "polkadot-api/sm-provider";
import type { JsonRpcProvider } from "@polkadot-api/json-rpc-provider";

import { getSmoldot, getRelayChain } from "./resolve";

// Well-known genesis hashes (Paseo testnet)
const PASEO_RELAY = "0x77afd6190f1554ad45fd0d31aee62aacc33c6db0ea801129acb813f913e0764f";
const ASSET_HUB_PASEO = "0x862c5c1eef2e2c2d7f98b3e71fbdb8ab03e62e7bea0b953bf1783f1e61b04471";

type ChainEntry = {
  chainSpec: string;
  isParachain: boolean;
};

const SUPPORTED_CHAINS: Record<string, ChainEntry> = {
  [PASEO_RELAY]: { chainSpec: paseoChainSpec, isParachain: false },
  [ASSET_HUB_PASEO]: { chainSpec: assetHubPaseoChainSpec, isParachain: true },
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
export function createChainProvider(genesisHash: string): JsonRpcProvider | null {
  const key = genesisHash.toLowerCase();
  const entry = SUPPORTED_CHAINS[key];
  if (!entry) return null;

  const cached = providerCache.get(key);
  if (cached) return cached;

  const smoldot = getSmoldot();

  let chainPromise;
  if (entry.isParachain) {
    chainPromise = getRelayChain().then((relayChain) =>
      smoldot.addChain({
        chainSpec: entry.chainSpec,
        potentialRelayChains: [relayChain],
      }),
    );
  } else {
    // Relay chain — reuse getRelayChain() for Paseo since it's the same chain
    chainPromise = key === PASEO_RELAY.toLowerCase()
      ? getRelayChain()
      : smoldot.addChain({ chainSpec: entry.chainSpec });
  }

  const provider = getSmProvider(chainPromise);
  providerCache.set(key, provider);
  return provider;
}
