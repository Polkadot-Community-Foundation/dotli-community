// dot.li — IndexedDB-backed label→CID cache
//
// Enables stale-while-revalidate: on repeat visits, render from
// the cached CID instantly while smoldot validates in the background.
//
// The canonical surface is the discriminated `getCachedCidResult` so
// callers can distinguish "miss" (run full resolution) from "error"
// (storage broken, surface to user). The legacy `getCachedCid` remains
// for incremental migration but collapses both into `null`.

import { getDb } from "./db";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import { isValidDotLabel } from "@dotli/shared/html";
import { log } from "@dotli/shared/log";
import { captureException } from "@dotli/metrics/sentry";

const STORE = "cids";

interface CidEntry {
  label: string;
  cid: string;
  timestamp: number;
}

export type CidCacheResult =
  | { kind: "hit"; cid: string }
  | { kind: "miss" }
  | { kind: "error"; cause: unknown };

export async function getCachedCidResult(
  label: string,
): Promise<CidCacheResult> {
  const stop = m.timer(S.CACHE_READ_LATENCY);
  try {
    const db = await getDb();
    return await new Promise<CidCacheResult>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(label);
      req.onsuccess = () => {
        const entry = req.result as CidEntry | undefined;
        stop();
        resolve(
          entry === undefined
            ? { kind: "miss" }
            : { kind: "hit", cid: entry.cid },
        );
      };
      req.onerror = () => {
        stop();
        resolve({
          kind: "error",
          cause: req.error ?? new Error("IDB read error"),
        });
      };
    });
  } catch (cause) {
    stop();
    return { kind: "error", cause };
  }
}

/**
 * Legacy surface — `null` collapses cache miss and storage error. New
 * callers should use `getCachedCidResult` so storage failures can be
 * surfaced rather than silently treated as "no cache".
 */
export async function getCachedCid(label: string): Promise<string | null> {
  const result = await getCachedCidResult(label);
  if (result.kind === "error") {
    log.error("[dot.li cid-cache] read error:", result.cause);
    captureException(result.cause, { kind: "cid_cache_read_error" });
    return null;
  }
  return result.kind === "hit" ? result.cid : null;
}

const RECENT_KEY = "dotli_recent";
const MAX_RECENT = 8;

export function getRecentLabels(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (raw === null || raw === "") {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((l): l is string => typeof l === "string" && isValidDotLabel(l))
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function addRecentLabel(label: string): Promise<void> {
  if (!isValidDotLabel(label)) {
    return Promise.resolve();
  }
  try {
    const recent = getRecentLabels().filter((l) => l !== label);
    recent.unshift(label);
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify(recent.slice(0, MAX_RECENT)),
    );
    // eslint-disable-next-line no-restricted-syntax -- localStorage unavailable / quota exceeded when appending to a UI-only "recent labels" list. Not worth a metric per page load; defaults keep working.
  } catch {
    /* non-critical — recent list is UI decoration */
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
  } catch (err) {
    stop();
    // Log + Sentry so operators can see when the cache is degrading; a
    // silent swallow would let an IDB regression go unnoticed.
    log.error("[dot.li cid-cache] write error:", err);
    captureException(err, { kind: "cid_cache_write_error" });
  }
}
