// dot.li — Resolution mode and cache settings
//
// Chain access and content fetch are two independent axes. The user picks
// one of each; the legacy three-way `DotliMode` enum is now a *preset label*
// computed from the two axes, kept for backwards compat (existing telemetry,
// existing UI call sites, URL params older sandbox builds still emit).
//
//   ChainBackend      : how .dot → CID and dApp chainConnect work
//   ContentBackend    : how CID → bytes works
//
// Presets:
//   "p2p-shared-worker" = smoldot-shared-worker + p2p-helia
//   "p2p-direct"        = smoldot-direct        + p2p-helia
//   "gateway"           = rpc                   + ipfs-gateway
//
// Non-preset combinations are legal (useful for debugging: e.g. gateway
// content with smoldot resolution to attribute which dependency broke).
// When the user picks a non-preset combo, the derived `DotliMode` surfaces
// as `"custom"` for display purposes only.

export type ChainBackend = "smoldot-shared-worker" | "smoldot-direct" | "rpc";
export type ContentBackend = "p2p-helia" | "ipfs-gateway";
export type DotliMode =
  | "p2p-shared-worker"
  | "p2p-direct"
  | "gateway"
  | "custom";

export interface CacheSettings {
  /** When true, skip CID cache reads — always resolve from chain/RPC */
  skipCidCache: boolean;
  /** When true, skip SW archive cache reads — always fetch content */
  skipArchiveCache: boolean;
  /**
   * When true, the protocol iframe purges its persistent worker caches
   * (IndexedDB) before smoldot/broker init, so every cold start boots
   * from scratch. Trades cold-start time for a deterministic baseline —
   * useful for debugging "is the cache hiding the issue?" scenarios.
   */
  skipWorkerCache: boolean;
}

// ── Backend storage keys ─────────────────────────────────────

const MODE_KEY = "dotli:mode";
const CHAIN_BACKEND_KEY = "dotli:chain-backend";
const CONTENT_BACKEND_KEY = "dotli:content-backend";

const VALID_CHAIN_BACKENDS: ReadonlySet<string> = new Set<ChainBackend>([
  "smoldot-shared-worker",
  "smoldot-direct",
  "rpc",
]);

const VALID_CONTENT_BACKENDS: ReadonlySet<string> = new Set<ContentBackend>([
  "p2p-helia",
  "ipfs-gateway",
]);

// Preset → (chain, content) table. Single source of truth for both
// derivation and migration from the legacy `dotli:mode` key.
const PRESETS: Record<
  Exclude<DotliMode, "custom">,
  { chain: ChainBackend; content: ContentBackend }
> = {
  "p2p-shared-worker": { chain: "smoldot-shared-worker", content: "p2p-helia" },
  "p2p-direct": { chain: "smoldot-direct", content: "p2p-helia" },
  gateway: { chain: "rpc", content: "ipfs-gateway" },
};

// ── Chain backend ────────────────────────────────────────────

export function getChainBackend(): ChainBackend {
  try {
    const stored = localStorage.getItem(CHAIN_BACKEND_KEY);
    if (stored !== null && VALID_CHAIN_BACKENDS.has(stored)) {
      return stored as ChainBackend;
    }
    // Migration: derive from legacy `dotli:mode` when the split key is absent.
    const legacy = readLegacyMode();
    if (legacy !== null && legacy !== "custom") {
      const chain = PRESETS[legacy].chain;
      localStorage.setItem(CHAIN_BACKEND_KEY, chain);
      return chain;
    }
    // Persist the computed default on first read so subsequent reads on
    // the same device give the same answer (without persistence we'd
    // re-derive via UA-sniff on every load, which can change between
    // browsers / devices).
    const computed = defaultChainBackend();
    localStorage.setItem(CHAIN_BACKEND_KEY, computed);
    return computed;
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode, quota, disabled cookies). Non-fatal by design: readers fall back to defaults, writers drop silently. No metric — noisy on every page load.
  } catch {
    /* localStorage unavailable — intentionally non-fatal. */
  }
  return defaultChainBackend();
}

/**
 * Default chain backend for first-load users (i.e. no persisted
 * preference + no legacy mode key).
 *
 * Paired with `ipfs-gateway` content this forms the `gateway` preset —
 * the fastest cold-start path because it skips smoldot entirely and
 * avoids the WASM + light-client sync budget. Users who want the
 * trustless path switch to `smoldot-shared-worker` / `smoldot-direct`
 * via the settings popover, and their choice is persisted in
 * localStorage so this function is not consulted again.
 */
function defaultChainBackend(): ChainBackend {
  return PRESETS["p2p-shared-worker"].chain;
}

export function setChainBackend(backend: ChainBackend): void {
  try {
    localStorage.setItem(CHAIN_BACKEND_KEY, backend);
    syncLegacyMode();
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode, quota, disabled cookies). Non-fatal by design: readers fall back to defaults, writers drop silently. No metric — noisy on every page load.
  } catch {
    /* localStorage unavailable — intentionally non-fatal. */
  }
}

// ── Content backend ──────────────────────────────────────────

export function getContentBackend(): ContentBackend {
  try {
    const stored = localStorage.getItem(CONTENT_BACKEND_KEY);
    if (stored !== null && VALID_CONTENT_BACKENDS.has(stored)) {
      return stored as ContentBackend;
    }
    const legacy = readLegacyMode();
    if (legacy !== null && legacy !== "custom") {
      const content = PRESETS[legacy].content;
      localStorage.setItem(CONTENT_BACKEND_KEY, content);
      return content;
    }
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode, quota, disabled cookies). Non-fatal by design: readers fall back to defaults, writers drop silently. No metric — noisy on every page load.
  } catch {
    /* localStorage unavailable — intentionally non-fatal. */
  }
  return PRESETS["p2p-shared-worker"].content;
}

export function setContentBackend(backend: ContentBackend): void {
  try {
    localStorage.setItem(CONTENT_BACKEND_KEY, backend);
    syncLegacyMode();
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode, quota, disabled cookies). Non-fatal by design: readers fall back to defaults, writers drop silently. No metric — noisy on every page load.
  } catch {
    /* localStorage unavailable — intentionally non-fatal. */
  }
}

// ── Legacy mode (derived, kept for display + backwards compat) ──

const LEGACY_MODE_VALUES: ReadonlySet<string> = new Set<DotliMode>([
  "p2p-shared-worker",
  "p2p-direct",
  "gateway",
  "custom",
]);

function readLegacyMode(): DotliMode | null {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    if (stored !== null && LEGACY_MODE_VALUES.has(stored)) {
      return stored as DotliMode;
    }
    // Pre-Phase-B values — map forward.
    if (stored === "p2p") {
      return "p2p-shared-worker";
    }
    if (stored === "centralized") {
      return "gateway";
    }
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode, quota, disabled cookies). Non-fatal by design: readers fall back to defaults, writers drop silently. No metric — noisy on every page load.
  } catch {
    /* localStorage unavailable — intentionally non-fatal. */
  }
  return null;
}

function deriveMode(chain: ChainBackend, content: ContentBackend): DotliMode {
  for (const [name, pair] of Object.entries(PRESETS) as [
    Exclude<DotliMode, "custom">,
    { chain: ChainBackend; content: ContentBackend },
  ][]) {
    if (pair.chain === chain && pair.content === content) {
      return name;
    }
  }
  return "custom";
}

function syncLegacyMode(): void {
  try {
    const mode = deriveMode(getChainBackend(), getContentBackend());
    localStorage.setItem(MODE_KEY, mode);
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode, quota, disabled cookies). Non-fatal by design: readers fall back to defaults, writers drop silently. No metric — noisy on every page load.
  } catch {
    /* localStorage unavailable — intentionally non-fatal. */
  }
}

/** The combined preset label (or `"custom"` for non-preset combinations). */
export function getMode(): DotliMode {
  return deriveMode(getChainBackend(), getContentBackend());
}

/** Directly set a preset. Convenience for existing call sites. */
export function setMode(mode: DotliMode): void {
  if (mode === "custom") {
    // "custom" isn't a preset — ignore; caller should use setChainBackend /
    // setContentBackend for non-preset combos.
    return;
  }
  const preset = PRESETS[mode];
  setChainBackend(preset.chain);
  setContentBackend(preset.content);
}

/**
 * Returns true when the chain backend is a smoldot variant (either
 * worker or direct).
 *
 * `mode` is ignored for the `"custom"` preset — "custom" is by
 * definition a free combination of `ChainBackend` + `ContentBackend`,
 * so the only authoritative source for its chain side is the persisted
 * `getChainBackend()`. For every non-custom preset we route through
 * the PRESETS table so a caller who just has a `DotliMode` in hand
 * gets a stable answer without re-reading storage.
 *
 * To avoid a silent argument mismatch, callers that aren't sure which
 * side of the chain/content split they have should use
 * `isP2pChainBackend(getChainBackend())` instead of passing a mode.
 */
export function isP2pMode(mode: DotliMode): boolean {
  if (mode === "custom") {
    return getChainBackend() !== "rpc";
  }
  return PRESETS[mode].chain !== "rpc";
}

/**
 * Single-axis helper for callers that already have a `ChainBackend`
 * and shouldn't have to round-trip through `DotliMode`. Preferred for
 * internal routing decisions — `isP2pMode` stays for call sites that
 * only carry the legacy preset label.
 */
export function isP2pChainBackend(backend: ChainBackend): boolean {
  return backend !== "rpc";
}

/**
 * Canonical trust-posture helper for user-facing shields and indicators.
 *
 * A session is "verified" only when BOTH axes are trustless — chain =
 * smoldot (shared-worker or direct) AND content = p2p-helia. If either
 * axis uses a trusted provider (chain = rpc OR content = ipfs-gateway),
 * the session is trusted, not verified, because part of the data path
 * relies on an operator the user has delegated trust to.
 *
 * This is the single source of truth for anything user-facing that
 * communicates verification state. Never re-derive the rule from raw
 * backend values at the call site — one place, one rule, one truth.
 */
export function isVerifiedSession(
  chain: ChainBackend,
  content: ContentBackend,
): boolean {
  return chain !== "rpc" && content !== "ipfs-gateway";
}

// ── Cache settings ───────────────────────────────────────────

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
 * Cache preferences are the user's to choose regardless of chain/content
 * backend. (Earlier versions coupled gateway mode to "no cache", which
 * meant the user couldn't say "I want gateway *and* keep the CID cache".
 * Cache flags are now honored as-set.)
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
