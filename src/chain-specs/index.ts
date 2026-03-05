// dot.li — Local chain specifications
//
// Fresh chain specs fetched as separate static files at runtime.
// Using ?url lets Vite hash them for cache-busting while keeping
// the ~150KB Paseo JSON out of the JS bundle entirely.
//
// Fetches start immediately when this module is first imported,
// running in parallel with smoldot worker initialization.
//
// To refresh these specs, run:
//   npm run update-chain-specs

import paseoUrl from "./paseo.json?url";
import assetHubPaseoUrl from "./asset-hub-paseo.json?url";

const paseoPromise = fetch(paseoUrl).then((r) => r.text());
const assetHubPromise = fetch(assetHubPaseoUrl).then((r) => r.text());

export function getPaseoChainSpec(): Promise<string> {
  return paseoPromise;
}

export function getAssetHubPaseoChainSpec(): Promise<string> {
  return assetHubPromise;
}
