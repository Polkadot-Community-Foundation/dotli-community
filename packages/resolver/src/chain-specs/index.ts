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
import bulletinPaseoUrl from "./bulletin-paseo.json?url";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";

// Lazy getters that retry on failure instead of caching a rejected promise.
let paseoPromise: Promise<string> | null = null;
let assetHubPromise: Promise<string> | null = null;
let bulletinPaseoPromise: Promise<string> | null = null;

export function getPaseoChainSpec(): Promise<string> {
  if (paseoPromise === null) {
    const stop = m.timer(S.CHAINSPEC_PASEO);
    paseoPromise = fetch(paseoUrl)
      .then((r) => r.text())
      .then((text) => {
        stop();
        return text;
      });
    paseoPromise.catch(() => {
      paseoPromise = null;
    });
  }
  return paseoPromise;
}

export function getAssetHubPaseoChainSpec(): Promise<string> {
  if (assetHubPromise === null) {
    const stop = m.timer(S.CHAINSPEC_ASSETHUB);
    assetHubPromise = fetch(assetHubPaseoUrl)
      .then((r) => r.text())
      .then((text) => {
        stop();
        return text;
      });
    assetHubPromise.catch(() => {
      assetHubPromise = null;
    });
  }
  return assetHubPromise;
}

export function getBulletinPaseoChainSpec(): Promise<string> {
  if (bulletinPaseoPromise === null) {
    const stop = m.timer(S.CHAINSPEC_BULLETIN);
    bulletinPaseoPromise = fetch(bulletinPaseoUrl)
      .then((r) => r.text())
      .then((text) => {
        stop();
        return text;
      });
    bulletinPaseoPromise.catch(() => {
      bulletinPaseoPromise = null;
    });
  }
  return bulletinPaseoPromise;
}
