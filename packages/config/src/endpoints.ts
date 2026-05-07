// dot.li — Active endpoint selection
//
// Thin wrappers over the curated defaults in `./config.ts`. Kept as
// functions (not re-exports) so future per-call dynamics — health-based
// rotation, per-region pinning — land without rippling through every
// caller.
//
// User-overridable custom endpoints and the `default`/`custom` profile
// were removed: there was no UI shipping them and the runtime couldn't
// honor the choice across the host/protocol/sandbox origin split without
// significant additional machinery. Until we're ready to ship that
// end-to-end, the config values are the only truth.

import { ASSET_HUB_PASEO_RPC, IPFS_GATEWAY, PASEO_RELAY_RPC } from "./config";

/**
 * The single RPC endpoint the runtime dials for Asset Hub Paseo.
 */
export function getActiveAssetHubRpcEndpoints(): string[] {
  return ASSET_HUB_PASEO_RPC;
}

/**
 * Companion relay-chain endpoint shown alongside the Asset Hub endpoint
 * in the rpc-gateway diagnostics. Not dialed by the runtime today.
 */
export function getActivePaseoRelayRpcEndpoints(): string[] {
  return PASEO_RELAY_RPC;
}

/** The single IPFS gateway base URL the runtime fetches from. */
export function getActiveIpfsGateway(): string {
  return IPFS_GATEWAY;
}
