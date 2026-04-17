// dot.li — Local chain specifications
//
// Fresh chain specs fetched as separate static files at runtime.
// Using ?url lets Vite hash them for cache-busting while keeping
// the ~150KB Paseo JSON out of the JS bundle entirely.
//
// Fetches start immediately when this module is first imported,
// running in parallel with smoldot worker initialization.
//
// NO silent retry. A rejected fetch is cached as a rejected promise so
// every subsequent call sees the same failure. Use `resetChainSpecCaches()`
// to opt in to a retry (e.g. from a user-driven "Retry" UI affordance).
// Fetches also explicitly check `r.ok` so a 404/500 HTML body cannot be
// fed to smoldot's chain-spec parser as if it were valid JSON.
//
// To refresh these specs, run:
//   npm run update-chain-specs

import paseoUrl from "./paseo.json?url";
import assetHubPaseoUrl from "./asset-hub-paseo.json?url";
import bulletinPaseoUrl from "./bulletin-paseo.json?url";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import { SS_PEOPLE_CHAIN, SS_RELAY_CHAIN } from "@dotli/config/config";

// Vite glob import: maps each people-chain spec to its hashed asset URL.
const peopleChainSpecs = import.meta.glob<string>("./*people*.json", {
  query: "?url",
  import: "default",
  eager: true,
});

// Vite glob import: all chain specs (used for custom relay chain lookup).
const allChainSpecs = import.meta.glob<string>("./*.json", {
  query: "?url",
  import: "default",
  eager: true,
});

function getPeopleChainSpecUrl(): string {
  const key = `./${SS_PEOPLE_CHAIN}.json`;
  const url = peopleChainSpecs[key];
  if (!url) {
    throw new Error(
      `Unknown people chain spec "${SS_PEOPLE_CHAIN}". ` +
        `Available: ${Object.keys(peopleChainSpecs).join(", ")}`,
    );
  }
  return url;
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
// `resetChainSpecCaches()` is invoked explicitly.
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
    assetHubPromise = fetchChainSpec(assetHubPaseoUrl).then((text) => {
      stop();
      return text;
    });
  }
  return assetHubPromise;
}

export function getBulletinPaseoChainSpec(): Promise<string> {
  if (bulletinPaseoPromise === null) {
    const stop = m.timer(S.CHAINSPEC_BULLETIN);
    bulletinPaseoPromise = fetchChainSpec(bulletinPaseoUrl).then((text) => {
      stop();
      return text;
    });
  }
  return bulletinPaseoPromise;
}

export function getPeopleChainSpec(): Promise<string> {
  peopleChainSpecPromise ??= fetchChainSpec(getPeopleChainSpecUrl());
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
