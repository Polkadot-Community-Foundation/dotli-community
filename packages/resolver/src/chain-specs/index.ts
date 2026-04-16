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

// Lazy getters that retry on failure instead of caching a rejected promise.
let paseoPromise: Promise<string> | null = null;
let assetHubPromise: Promise<string> | null = null;
let bulletinPaseoPromise: Promise<string> | null = null;
let peopleChainSpecPromise: Promise<string> | null = null;
let customRelayPromise: Promise<string> | null = null;

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

export function getPeopleChainSpec(): Promise<string> {
  if (peopleChainSpecPromise === null) {
    peopleChainSpecPromise = fetch(getPeopleChainSpecUrl()).then((r) =>
      r.text(),
    );
    peopleChainSpecPromise.catch(() => {
      peopleChainSpecPromise = null;
    });
  }
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
    customRelayPromise = fetch(url).then((r) => r.text());
    customRelayPromise.catch(() => {
      customRelayPromise = null;
    });
  }
  return customRelayPromise;
}
