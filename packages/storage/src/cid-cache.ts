// dot.li — IndexedDB-backed label→CID cache
//
// Enables stale-while-revalidate: on repeat visits, render from
// the cached CID instantly while smoldot validates in the background.

import { getDb } from "./db";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";

const STORE = "cids";

interface CidEntry {
  label: string;
  cid: string;
  timestamp: number;
}

export async function getCachedCid(label: string): Promise<string | null> {
  const stop = m.timer(S.CACHE_READ_LATENCY);
  try {
    const db = await getDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(label);
      req.onsuccess = () => {
        const entry = req.result as CidEntry | undefined;
        stop();
        resolve(entry?.cid ?? null);
      };
      req.onerror = () => {
        stop();
        resolve(null);
      };
    });
  } catch {
    stop();
    return null;
  }
}

const RECENT_KEY = "dotli_recent";
const MAX_RECENT = 8;

export function getRecentLabels(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (raw === null || raw === "") {
      return [];
    }
    const labels = JSON.parse(raw) as string[];
    return Array.isArray(labels) ? labels.slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function addRecentLabel(label: string): Promise<void> {
  try {
    const recent = getRecentLabels().filter((l) => l !== label);
    recent.unshift(label);
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify(recent.slice(0, MAX_RECENT)),
    );
  } catch {
    // Non-critical
  }
  return Promise.resolve();
}

export async function setCachedCid(label: string, cid: string): Promise<void> {
  const stop = m.timer(S.CACHE_WRITE_LATENCY);
  try {
    const db = await getDb();
    const tx = db.transaction(STORE, "readwrite");
    const entry: CidEntry = {
      label,
      cid,
      timestamp: Date.now(),
    };
    tx.objectStore(STORE).put(entry);
    stop();
  } catch {
    stop();
    // Cache write failure is non-critical
  }
}
