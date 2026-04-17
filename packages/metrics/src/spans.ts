// dot.li — Pre-defined metric names
//
// Metric name constants so instrumentation is consistent
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

/**
 * Presync outcome — same series as `SMOLDOT_PRESYNC`. Callers emit
 * `m.count(SMOLDOT_PRESYNC, { outcome: "error", reason })` instead of a
 * parallel `_FAILURE` name so dashboards can chart one line per event.
 */

// ── Protocol initialization ────────────────────────────────────

/** Total protocol iframe init (mode detection + engine start) */
export const PROTOCOL_INIT = "protocol.init";

/** Time from SharedWorker creation to "ready" signal */
export const PROTOCOL_SW_READY = "protocol.sw_ready";

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

/** Time to fetch content via P2P. Timeouts emit `{ outcome: "timeout" }`. */
export const CONTENT_P2P = "content.p2p";

/** Time to fetch content via IPFS gateway (gateway mode) */
export const CONTENT_GATEWAY = "content.gateway";

/** Total content fetch time (whichever method wins) */
export const CONTENT_FETCH = "content.fetch";

// ── End-to-end ─────────────────────────────────────────────────

/** Fast path: CID cache hit to content rendered */
export const E2E_FAST = "e2e.fast_path";

/** Slow path: CID cache miss → resolve → fetch → render */
export const E2E_SLOW = "e2e.slow_path";

// ── Chain connectivity ─────────────────────────────────────────

/** Bootnode WebSocket connection failure */
export const BOOTNODE_ERROR = "bootnode.error";

// ── Content fetching ────────────────────────────────────────────

/** Helia P2P client initialization (peer discovery + connect) */
export const CONTENT_HELIA_INIT = "content.helia_init";

/** Fetched content size in bytes */
export const CONTENT_SIZE = "content.size";

// ── CID cache ──────────────────────────────────────────────────

/** IndexedDB read latency for CID lookup */
export const CACHE_READ_LATENCY = "cache.read_latency";

/** IndexedDB write latency for CID store */
export const CACHE_WRITE_LATENCY = "cache.write_latency";

// ── Chain spec loading ─────────────────────────────────────────

/** Time to fetch Paseo relay chain spec */
export const CHAINSPEC_PASEO = "chainspec.paseo";

/** Time to fetch Asset Hub chain spec */
export const CHAINSPEC_ASSETHUB = "chainspec.assethub";

/** Time to fetch Bulletin chain spec */
export const CHAINSPEC_BULLETIN = "chainspec.bulletin";

// ── App context (sandbox) ──────────────────────────────────────

/** Total sandbox app load time */
export const APP_TOTAL = "app.total";

/** Service worker registration time */
export const APP_SW_REGISTER = "app.sw_register";

/** Content render time in sandbox */
export const APP_RENDER = "app.render";

// ── Protocol client ────────────────────────────────────────────

/**
 * Protocol iframe creation + ready wait. Load failures emit
 * `m.count(PROTOCOL_IFRAME_READY, { outcome: "error", reason })`; the
 * parallel `_LOAD_FAILURE` constant is retired.
 */
export const PROTOCOL_IFRAME_READY = "protocol.iframe_ready";

/**
 * Protocol request roundtrip time. Timeouts emit
 * `m.count(PROTOCOL_REQUEST, { outcome: "timeout", method })`; there is
 * no separate `_TIMEOUT` constant.
 */
export const PROTOCOL_REQUEST = "protocol.request";

// ── Container bridge ───────────────────────────────────────────

/** Container chunk dynamic import time */
export const BRIDGE_CHUNK_LOAD = "bridge.chunk_load";

/** Container bridge setup time */
export const BRIDGE_SETUP = "bridge.setup";

// ── Auth ───────────────────────────────────────────────────────

/** Session restore from storage */
export const AUTH_SESSION_RESTORE = "auth.session_restore";

// ── WASM ───────────────────────────────────────────────────────

/** WASM module load time (captured via PerformanceObserver) */
export const WASM_LOAD = "wasm.load";
