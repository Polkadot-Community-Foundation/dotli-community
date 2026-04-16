// dot.li — Resolution mode and cache settings
//
// The user chooses between three mutually exclusive modes:
//   "p2p-shared-worker" — smoldot in SharedWorker + Helia/bitswap (default)
//   "p2p-direct"        — smoldot per-tab + Helia/bitswap
//   "gateway"           — JSON-RPC + IPFS gateway (trusted, faster, no cache)

export type DotliMode = "p2p-shared-worker" | "p2p-direct" | "gateway";

export interface CacheSettings {
  /** When true, skip CID cache reads — always resolve from chain/RPC */
  skipCidCache: boolean;
  /** When true, skip SW archive cache reads — always fetch content */
  skipArchiveCache: boolean;
}

// ── Mode ─────────────────────────────────────────────────────

const MODE_KEY = "dotli:mode";

const VALID_MODES: ReadonlySet<string> = new Set<DotliMode>([
  "p2p-shared-worker",
  "p2p-direct",
  "gateway",
]);

export function getMode(): DotliMode {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    if (stored !== null && VALID_MODES.has(stored)) {
      return stored as DotliMode;
    }
    // Migration: old values → new
    if (stored === "p2p") {
      localStorage.setItem(MODE_KEY, "p2p-shared-worker");
      return "p2p-shared-worker";
    }
    if (stored === "centralized") {
      localStorage.setItem(MODE_KEY, "gateway");
      return "gateway";
    }
  } catch {
    // localStorage may be unavailable (e.g. opaque origin)
  }
  return "p2p-shared-worker";
}

export function setMode(mode: DotliMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // localStorage may be unavailable
  }
}

/** Returns true for any P2P variant, false for gateway. */
export function isP2pMode(mode: DotliMode): boolean {
  return mode !== "gateway";
}

// ── Cache settings ───────────────────────────────────────────

const CACHE_KEY = "dotli:cache-settings";

const DEFAULT_CACHE: CacheSettings = {
  skipCidCache: false,
  skipArchiveCache: false,
};

/**
 * Get the effective cache settings.
 *
 * In gateway mode, all cache reads are forced to skip — the gateway path
 * is the fast route and doesn't benefit from caching. The user's P2P
 * cache preferences are preserved in localStorage so switching back to
 * P2P restores them.
 */
export function getCacheSettings(mode?: DotliMode): CacheSettings {
  // Gateway mode: force all caches off (reads only — writes still happen)
  if ((mode ?? getMode()) === "gateway") {
    return { skipCidCache: true, skipArchiveCache: true };
  }

  try {
    const stored = localStorage.getItem(CACHE_KEY);
    if (stored !== null) {
      const parsed = JSON.parse(stored) as Partial<CacheSettings>;
      return {
        skipCidCache: parsed.skipCidCache === true,
        skipArchiveCache: parsed.skipArchiveCache === true,
      };
    }
  } catch {
    // Invalid JSON or storage unavailable
  }
  return { ...DEFAULT_CACHE };
}

export function setCacheSettings(settings: CacheSettings): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage may be unavailable
  }
}
