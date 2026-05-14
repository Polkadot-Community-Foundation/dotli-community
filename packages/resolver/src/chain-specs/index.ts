// dot.li — Local chain specifications
//
// Fresh chain specs fetched as separate static files at runtime.
// Using ?url lets Vite hash them for cache-busting while keeping
// the ~150KB Paseo JSON out of the JS bundle entirely.
//
// Fetches start immediately when the getter is first called,
// running in parallel with smoldot worker initialization.
//
// Paseo Next runs two co-existing testnets (V1 = current "next", V2 =
// newer "next" system chains). The relay is shared between them; the
// system parachains diverge. The active getter routes to the right URL
// based on the user-selected `Network` from `@dotli/config/mode`.
//
// NO silent retry. A rejected fetch is cached as a rejected promise so
// every subsequent call sees the same failure. Use `resetChainSpecCaches()`
// to opt in to a retry (e.g. from a user-driven "Retry" UI affordance).
// Fetches also explicitly check `r.ok` so a 404/500 HTML body cannot be
// fed to smoldot's chain-spec parser as if it were valid JSON.
//
// To refresh these specs, run:
//   npm run update-chain-specs

import paseoUrl from "./paseo.smol.json?url";
import assetHubPaseoV1Url from "./paseo-asset-hub.smol.json?url";
import assetHubPaseoV2Url from "./paseo-asset-hub-next.smol.json?url";
import bulletinPaseoV1Url from "./paseo-bulletin.smol.json?url";
import bulletinPaseoV2Url from "./paseo-bulletin-next.smol.json?url";
import peoplePaseoV1Url from "./paseo-people-next.smol.json?url";
import peoplePaseoV2Url from "./paseo-people-next-system.smol.json?url";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import { SS_RELAY_CHAIN } from "@dotli/config/config";
import { getNetwork, type Network } from "@dotli/config/network";

// Vite glob import: all chain specs (used for the optional custom relay
// override via `SS_RELAY_CHAIN`).
const allChainSpecs = import.meta.glob<string>("./*.json", {
  query: "?url",
  import: "default",
  eager: true,
});

function assetHubUrlFor(network: Network): string {
  return network === "paseo-next-v2" ? assetHubPaseoV2Url : assetHubPaseoV1Url;
}

function bulletinUrlFor(network: Network): string {
  return network === "paseo-next-v2" ? bulletinPaseoV2Url : bulletinPaseoV1Url;
}

function peopleUrlFor(network: Network): string {
  return network === "paseo-next-v2" ? peoplePaseoV2Url : peoplePaseoV1Url;
}

async function fetchChainSpec(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(
      `Chain spec fetch failed: ${String(r.status)} ${r.statusText} (${url})`,
    );
  }
  return r.text();
}

// Cached promises. Rejections are NOT cleared — a failure is sticky until
// `resetChainSpecCaches()` is invoked explicitly. The network selection
// is stable for the lifetime of a page load (switching it triggers a
// wipe + reload), so we don't key these caches by network.
let paseoPromise: Promise<string> | null = null;
let assetHubPromise: Promise<string> | null = null;
let bulletinPaseoPromise: Promise<string> | null = null;
let peopleChainSpecPromise: Promise<string> | null = null;
let customRelayPromise: Promise<string> | null = null;

export function getPaseoChainSpec(): Promise<string> {
  if (paseoPromise === null) {
    const stop = m.timer(S.CHAINSPEC_PASEO);
    paseoPromise = fetchChainSpec(paseoUrl).then((text) => {
      stop();
      return text;
    });
  }
  return paseoPromise;
}

export function getAssetHubPaseoChainSpec(): Promise<string> {
  if (assetHubPromise === null) {
    const stop = m.timer(S.CHAINSPEC_ASSETHUB);
    assetHubPromise = fetchChainSpec(assetHubUrlFor(getNetwork())).then(
      (text) => {
        stop();
        return text;
      },
    );
  }
  return assetHubPromise;
}

export function getBulletinPaseoChainSpec(): Promise<string> {
  if (bulletinPaseoPromise === null) {
    const stop = m.timer(S.CHAINSPEC_BULLETIN);
    bulletinPaseoPromise = fetchChainSpec(bulletinUrlFor(getNetwork())).then(
      (text) => {
        stop();
        return text;
      },
    );
  }
  return bulletinPaseoPromise;
}

export function getPeopleChainSpec(): Promise<string> {
  peopleChainSpecPromise ??= fetchChainSpec(peopleUrlFor(getNetwork()));
  return peopleChainSpecPromise;
}

export function getCustomRelayChainSpec(): Promise<string> {
  if (customRelayPromise === null) {
    const key = `./${String(SS_RELAY_CHAIN)}.json`;
    const url = allChainSpecs[key];
    if (!url) {
      throw new Error(
        `Unknown relay chain spec "${String(SS_RELAY_CHAIN)}". ` +
          `Available: ${Object.keys(allChainSpecs).join(", ")}`,
      );
    }
    customRelayPromise = fetchChainSpec(url);
  }
  return customRelayPromise;
}

/**
 * Clear all cached chain-spec promises so the next getter call performs a
 * fresh fetch. Call this from explicit user-driven retry paths only — never
 * from automatic recovery code.
 */
export function resetChainSpecCaches(): void {
  paseoPromise = null;
  assetHubPromise = null;
  bulletinPaseoPromise = null;
  peopleChainSpecPromise = null;
  customRelayPromise = null;
}
