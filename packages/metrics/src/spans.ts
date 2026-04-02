// dot.li — Pre-defined metric names
//
// Centralized metric name constants so instrumentation is consistent
// and discoverable. All names are prefixed with "dotli." automatically
// by the metrics API — these are the suffixes.

// ── Smoldot lifecycle ──────────────────────────────────────────

/** Time to create smoldot instance (start() or startFromWorker()) */
export const SMOLDOT_CREATE = "smoldot.create";

/** Time to add relay chain (fetch chain spec + addChain) */
export const SMOLDOT_RELAY_CHAIN = "smoldot.relay_chain";

/** Time to add Asset Hub parachain */
export const SMOLDOT_ASSET_HUB = "smoldot.asset_hub";

/** Time from client creation to first finalized block */
export const SMOLDOT_FINALIZED_BLOCK = "smoldot.finalized_block";

/** Total presync duration (create + relay + asset hub + finalized block) */
export const SMOLDOT_PRESYNC = "smoldot.presync";

/** Number of presync attempts before success (1 = first try) */
export const SMOLDOT_PRESYNC_ATTEMPTS = "smoldot.presync_attempts";

/** Presync failed after all retries */
export const SMOLDOT_PRESYNC_FAILURE = "smoldot.presync_failure";

// ── Protocol initialization ────────────────────────────────────

/** Total protocol iframe init (mode detection + engine start) */
export const PROTOCOL_INIT = "protocol.init";

/** Time from SharedWorker creation to "alive" signal */
export const PROTOCOL_SW_ALIVE = "protocol.sw_alive";

/** Time from SharedWorker creation to "ready" signal */
export const PROTOCOL_SW_READY = "protocol.sw_ready";

/** SharedWorker timed out (no "alive" or "ready") */
export const PROTOCOL_SW_TIMEOUT = "protocol.sw_timeout";

/** Which protocol mode was selected */
export const PROTOCOL_MODE = "protocol.mode";

// ── Name resolution ────────────────────────────────────────────

/** Total time to resolve a .dot name to CID */
export const RESOLVE_TOTAL = "resolve.total";

/** Time for a single contract storage read */
export const RESOLVE_STORAGE_READ = "resolve.storage_read";

// ── CID cache ──────────────────────────────────────────────────

/** CID cache hit — page loads from cache (fast path) */
export const CACHE_HIT = "cache.hit";

/** CID cache miss — full resolution required (slow path) */
export const CACHE_MISS = "cache.miss";

// ── Content loading ────────────────────────────────────────────

/** Time to fetch content via P2P */
export const CONTENT_P2P = "content.p2p";

/** Time to fetch content via gateway fallback */
export const CONTENT_GATEWAY = "content.gateway";

/** Total content fetch time (whichever method wins) */
export const CONTENT_FETCH = "content.fetch";

// ── End-to-end ─────────────────────────────────────────────────

/** Total page load: main() start to content rendered */
export const E2E_TOTAL = "e2e.total";

/** Fast path: CID cache hit to content rendered */
export const E2E_FAST = "e2e.fast_path";

/** Slow path: CID cache miss → resolve → fetch → render */
export const E2E_SLOW = "e2e.slow_path";

// ── Chain connectivity ─────────────────────────────────────────

/** Bootnode WebSocket connection failure */
export const BOOTNODE_ERROR = "bootnode.error";
