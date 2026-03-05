// dot.li — Local chain specifications
//
// Fresh chain specs fetched directly from RPC nodes.
// The Paseo relay spec includes an up-to-date lightSyncState checkpoint,
// which dramatically reduces smoldot sync time vs the stale checkpoint
// bundled with polkadot-api.
//
// To refresh these specs, run:
//   npm run update-chain-specs

import paseoSpec from "./paseo.json?raw";
import assetHubPaseoSpec from "./asset-hub-paseo.json?raw";

export const paseoChainSpec: string = paseoSpec;
export const assetHubPaseoChainSpec: string = assetHubPaseoSpec;
