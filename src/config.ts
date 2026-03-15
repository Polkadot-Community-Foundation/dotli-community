// dot.li Universal Viewer — Configuration
// Contract addresses, chain config, peer multiaddrs, and minimal ABIs.

// Supports dot.li, paseo.li, or any future two-segment domain.
// Falls back to "dot.li" for localhost / unknown hosts.
const hostname = self.location.hostname;
const segments = hostname.split(".");
export const BASE_DOMAIN =
  segments.length >= 2 &&
  !hostname.endsWith(".localhost") &&
  hostname !== "localhost"
    ? `${segments[segments.length - 2]}.${segments[segments.length - 1]}`
    : "dot.li";

// --- Site identity -------------------------------------------------------

export type SiteId = "dot.li" | "paseo.li" | "local.li";

const isLocalhost =
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "127.0.0.1";

export const SITE_ID: SiteId = isLocalhost
  ? "local.li"
  : (BASE_DOMAIN as SiteId);

// --- Debug logging -------------------------------------------------------

export const DEBUG =
  (import.meta.env.VITE_APP_DEBUG as string | undefined) !== "false";

// --- dotNS Contracts on Asset Hub Paseo (Revive EVM pallet) ---

export const CONTRACTS = {
  DOTNS_REGISTRY: "0x4Da0d37aBe96C06ab19963F31ca2DC0412057a6f" as const,
  DOTNS_CONTENT_RESOLVER: "0x7756DF72CBc7f062e7403cD59e45fBc78bed1cD7" as const,
};

// The `.dot` TLD namehash node
export const DOT_NODE =
  "0x3fce7d1364a893e213bc4212792b517ffc88f5b13b86c8ef9c8d390c3a1370ce" as const;

// --- Revive dry-run limits (max values for read-only calls) ---

export const DRY_RUN_WEIGHT_LIMIT = {
  ref_time: 18446744073709551615n,
  proof_size: 18446744073709551615n,
};

export const DRY_RUN_STORAGE_LIMIT = 18446744073709551615n;

// A dummy substrate address for read-only calls (Alice's well-known dev address)
export const DUMMY_ORIGIN = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

// --- Bulletin Chain Paseo — Peer multiaddrs for Helia P2P ---

export const BULLETIN_PEERS = [
  "/dns4/paseo-bulletin-collator-node-0.parity-testnet.parity.io/tcp/443/wss/p2p/12D3KooWRuKisocQ2Z5hBZagV5YGxJMYuW13xT42sUiUCWf5bRtu",
  "/dns4/paseo-bulletin-collator-node-1.parity-testnet.parity.io/tcp/443/wss/p2p/12D3KooWSgdX2egCUiXtDUNV6hGh6JrtTb9vQ6iRfFMdnTemQDDp",
  "/dns4/paseo-bulletin-rpc-node-0.polkadot.io/tcp/443/wss/p2p/12D3KooWG7dt8yAMBaNrWh5juvHMGvJtPKTCaS87kkadWZKpV7ox",
  "/dns4/paseo-bulletin-rpc-node-1.polkadot.io/tcp/443/wss/p2p/12D3KooWSS9QNRiLGBoZrDrtXvPyBV7QrV7F3A1V8f6xAXECSnj5",
];

// --- IPFS Gateway fallback ---

export const IPFS_GATEWAY = "https://paseo-ipfs.polkadot.io";

// --- Asset Hub Paseo public RPC (for fast gateway CID resolution) ---

export const ASSET_HUB_PASEO_RPC = ["wss://sys.ibp.network/asset-hub-paseo"];

// --- SW archive cache ---

/** Max number of domain archives kept in the SW in-memory LRU cache. */
export const SW_ARCHIVE_CACHE_MAX = 8;

// --- Timeouts (ms) ---

export const TIMEOUTS = {
  /** SW cache lookup before falling through */
  SW_CACHE_LOOKUP: 3_000,
  /** Waiting for SW controllerchange after registration */
  SW_READY: 10_000,
  /** SW smoldot ready check */
  SW_SMOLDOT_READY: 500,
  /** SW smoldot connect handshake */
  SW_SMOLDOT_CONNECT: 30_000,
  /** P2P fetch abort */
  P2P_FETCH: 60_000,
  /** Gateway CID resolution */
  GATEWAY_RESOLVE: 6_000,
  /** Initial relay DB save after smoldot starts */
  RELAY_DB_FIRST_SAVE: 5_000,
  /** Periodic relay DB save interval */
  RELAY_DB_SAVE_INTERVAL: 60_000,
  /** Timeout for SW smoldot getFinalizedBlock before falling back */
  SW_SMOLDOT_SYNC: 5_000,
  /** Delay before starting smoldot in SW activate */
  SW_SMOLDOT_INIT_DELAY: 100,
} as const;

/** Max bytes for `chainHead_unstable_finalizedDatabase` RPC param. */
export const FINALIZED_DB_MAX_SIZE = 1_000_000;
