// dot.li: Backend selection and cache settings.
//
// One axis: `Backend ∈ { smoldot-direct, smoldot-shared-worker, rpc-gateway }`.
//
//   smoldot-direct: smoldot runs in the protocol iframe. Chain access
//                   uses smoldot, content fetch uses smoldot's
//                   `bitswap_v1_get` against the Bulletin Chain.
//   smoldot-shared-worker: same as above but smoldot lives in a SharedWorker,
//                   so multiple tabs share one light client.
//   rpc-gateway: chain access via WSS JSON-RPC to a trusted node, content
//                fetch via HTTPS IPFS gateway. No smoldot.
//
// `Backend` replaced the older two-axis (`ChainBackend × ContentBackend`)
// model. With `bitswap_v1_get` available on smoldot, the chain transport
// and the content transport ride together. There's no useful product
// position that mixes them. The collapse drops Helia/libp2p from the
// dependency graph entirely.

export type Backend =
  | "smoldot-direct"
  | "smoldot-shared-worker"
  | "rpc-gateway";

export interface CacheSettings {
  /** When true, skip CID cache reads. Always resolve from chain/RPC. */
  skipCidCache: boolean;
  /** When true, skip SW archive cache reads. Always fetch content. */
  skipArchiveCache: boolean;
  /**
   * When true, the protocol iframe purges its persistent worker caches
   * (IndexedDB) before smoldot/broker init, so every cold start boots
   * from scratch. Trades cold-start time for a deterministic baseline,
   * useful for debugging "is the cache hiding the issue?" scenarios.
   */
  skipWorkerCache: boolean;
}

const BACKEND_KEY = "dotli:chain-backend";

// Pre-collapse keys. `rpc` chain backend maps to `rpc-gateway`. Legacy
// `dotli:mode` and `dotli:content-backend` carried the content axis that
// no longer exists. Read once, migrate, delete.
const LEGACY_MODE_KEY = "dotli:mode";
const LEGACY_CONTENT_BACKEND_KEY = "dotli:content-backend";

const VALID_BACKENDS: ReadonlySet<string> = new Set<Backend>([
  "smoldot-direct",
  "smoldot-shared-worker",
  "rpc-gateway",
]);

export function getBackend(): Backend {
  try {
    const stored = localStorage.getItem(BACKEND_KEY);
    if (stored !== null && VALID_BACKENDS.has(stored)) {
      return stored as Backend;
    }
    const migrated = migrateLegacy();
    if (migrated !== null) {
      localStorage.setItem(BACKEND_KEY, migrated);
      return migrated;
    }
    const computed = defaultBackend();
    localStorage.setItem(BACKEND_KEY, computed);
    return computed;
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode, quota, disabled cookies). Non-fatal by design: readers fall back to defaults, writers drop silently. No metric — noisy on every page load.
  } catch {
    /* localStorage unavailable — intentionally non-fatal. */
  }
  return defaultBackend();
}

export function setBackend(chainBackend: Backend): void {
  try {
    localStorage.setItem(BACKEND_KEY, chainBackend);
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode, quota, disabled cookies). Non-fatal by design: readers fall back to defaults, writers drop silently. No metric — noisy on every page load.
  } catch {
    /* localStorage unavailable — intentionally non-fatal. */
  }
}

/**
 * Default for first-load users. `smoldot-direct` is the trustless,
 * self-contained entry point (single-tab smoldot, no cross-tab
 * coordination, no SharedWorker lifecycle quirks). Users who want the
 * shared-worker path or the fast gateway path switch via the settings
 * popover. The choice is then persisted so this is not consulted again.
 */
function defaultBackend(): Backend {
  return "smoldot-direct";
}

/**
 * One-shot migration from pre-collapse stored values. The chain-backend
 * key is unchanged, but `rpc` becomes `rpc-gateway`. Old `dotli:mode`
 * and `dotli:content-backend` carried the content axis that no longer
 * exists, so they're cleared.
 */
function migrateLegacy(): Backend | null {
  let chosen: Backend | null = null;
  try {
    const chain = localStorage.getItem(BACKEND_KEY);
    const content = localStorage.getItem(LEGACY_CONTENT_BACKEND_KEY);
    const legacyMode = localStorage.getItem(LEGACY_MODE_KEY);
    if (chain === "rpc" || content === "ipfs-gateway") {
      chosen = "rpc-gateway";
    } else if (legacyMode === "p2p-shared-worker" || legacyMode === "p2p") {
      chosen = "smoldot-shared-worker";
    } else if (legacyMode === "p2p-direct") {
      chosen = "smoldot-direct";
    } else if (legacyMode === "gateway" || legacyMode === "centralized") {
      chosen = "rpc-gateway";
    }
    if (chosen !== null) {
      localStorage.removeItem(LEGACY_MODE_KEY);
      localStorage.removeItem(LEGACY_CONTENT_BACKEND_KEY);
    }
    // eslint-disable-next-line no-restricted-syntax -- localStorage probe. Non-fatal.
  } catch {
    /* fall through to null */
  }
  return chosen;
}

/**
 * Canonical trust-posture helper for user-facing shields and indicators.
 *
 * A session is "verified" iff the backend uses smoldot end-to-end. The
 * `rpc-gateway` backend delegates both chain access and content fetch to
 * trusted operators, so it's "trusted" rather than "verified".
 */
export function isVerifiedSession(chainBackend: Backend): boolean {
  return chainBackend !== "rpc-gateway";
}

const CACHE_KEY = "dotli:cache-settings";

// Fresh-install default: every cache off. The cached layers (dotNS CID
// resolution, SW archive, protocol worker IDB) can mask real behavior
// and confuse debugging — "did my code actually run, or did a stale
// cache win?". Users who want the speed boost opt in through the
// settings popover; existing users with a persisted preference keep
// whatever they chose.
const DEFAULT_CACHE: CacheSettings = {
  skipCidCache: true,
  skipArchiveCache: true,
  skipWorkerCache: true,
};

/**
 * Get the effective cache settings.
 *
 * Cache preferences are the user's to choose regardless of backend.
 * (Earlier versions coupled gateway mode to "no cache", which meant the
 * user couldn't say "I want gateway *and* keep the CID cache". Cache
 * flags are now honored as-set.)
 *
 * When a stored preference omits a field (older build wrote a partial
 * object), the missing field falls back to `DEFAULT_CACHE` so the new
 * all-off default applies instead of the structural zero-value `false`.
 */
export function getCacheSettings(): CacheSettings {
  try {
    const stored = localStorage.getItem(CACHE_KEY);
    if (stored !== null) {
      const parsed = JSON.parse(stored) as Partial<CacheSettings>;
      return {
        skipCidCache:
          typeof parsed.skipCidCache === "boolean"
            ? parsed.skipCidCache
            : DEFAULT_CACHE.skipCidCache,
        skipArchiveCache:
          typeof parsed.skipArchiveCache === "boolean"
            ? parsed.skipArchiveCache
            : DEFAULT_CACHE.skipArchiveCache,
        skipWorkerCache:
          typeof parsed.skipWorkerCache === "boolean"
            ? parsed.skipWorkerCache
            : DEFAULT_CACHE.skipWorkerCache,
      };
    }
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable or contain invalid JSON from an older build; defaults are the safe fallback. No metric — not worth one per page load.
  } catch {
    /* localStorage unavailable or malformed JSON — fall back to defaults. */
  }
  return { ...DEFAULT_CACHE };
}

export function setCacheSettings(settings: CacheSettings): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(settings));
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode, quota, disabled cookies). Non-fatal by design: readers fall back to defaults, writers drop silently. No metric — noisy on every page load.
  } catch {
    /* localStorage unavailable — intentionally non-fatal. */
  }
}
