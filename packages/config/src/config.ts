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

// --- Solidity storage slot numbers for direct storage reads ---
// Derived from the dotNS contracts using OpenZeppelin v5 (ERC-7201 namespaced
// storage). OZ v5 stores Initializable/OwnableUpgradeable/ERC165 state at
// hash-derived locations, so the contract's own variables start at slot 0.
//
// DotnsRegistry layout (own variables only):
//   slot 0: records  mapping(bytes32 => Record{address owner, address resolver, bool exists})
//   slot 1: registrarController
//   slot 2: dotnsRegistrar
//   slot 3: reverseResolver
//   slot 4: storeFactory
//
// DotnsContentResolver layout (own variables only):
//   slot 0: registry (address)
//   slot 1: contenthashes  mapping(bytes32 => bytes)
//   slot 2: textRecords
//   slot 3: operators
export const STORAGE_SLOTS = {
  /** DotnsRegistry: mapping(bytes32 => Record) at slot 0 */
  REGISTRY_RECORDS: 0,
  /** DotnsContentResolver: mapping(bytes32 => bytes) at slot 1 */
  CONTENTHASH: 1,
} as const;

// --- Bulletin Chain — Peer multiaddrs for Helia P2P ---

export const BULLETIN_PEERS_PASEO = [
  "/dns4/paseo-bulletin-collator-node-0.parity-testnet.parity.io/tcp/443/wss/p2p/12D3KooWRuKisocQ2Z5hBZagV5YGxJMYuW13xT42sUiUCWf5bRtu",
  "/dns4/paseo-bulletin-collator-node-1.parity-testnet.parity.io/tcp/443/wss/p2p/12D3KooWSgdX2egCUiXtDUNV6hGh6JrtTb9vQ6iRfFMdnTemQDDp",
  "/dns4/paseo-bulletin-rpc-node-0.polkadot.io/tcp/443/wss/p2p/12D3KooWG7dt8yAMBaNrWh5juvHMGvJtPKTCaS87kkadWZKpV7ox",
  "/dns4/paseo-bulletin-rpc-node-1.polkadot.io/tcp/443/wss/p2p/12D3KooWSS9QNRiLGBoZrDrtXvPyBV7QrV7F3A1V8f6xAXECSnj5",
];

export const BULLETIN_PEERS_WESTEND = [
  "/dns4/westend-bulletin-rpc-node-0.polkadot.io/tcp/443/wss/p2p/12D3KooWGb3sdXpdQPvL1wwHYHpQpMAEWxpgNNb6sndHmCByMXZw",
  "/dns4/westend-bulletin-rpc-node-1.polkadot.io/tcp/443/wss/p2p/12D3KooWN8hBVUWXNiur1w6EiEPkTJibbzpagZmm4cphMxWLv9yc",
  "/dns4/westend-bulletin-collator-node-0.parity-testnet.parity.io/tcp/443/wss/p2p/12D3KooWSxYQRoTT9rZNZRrjCfG2fPpBwPumkQsxLroTKjX6Mvkw",
  "/dns4/westend-bulletin-collator-node-1.parity-testnet.parity.io/tcp/443/wss/p2p/12D3KooWSD5tovFkmja9aFYA6QM8eU3mFhZKdAuCsa5MgSsNDmxc",
];

export const BULLETIN_PEERS = [
  ...BULLETIN_PEERS_PASEO,
  ...BULLETIN_PEERS_WESTEND,
];

// --- IPFS Gateways (same as console-ui/src/lib/ipfs.ts) ---

export const IPFS_GATEWAYS: Record<string, string> = {
  local: "http://127.0.0.1:8283",
  paseo: "https://paseo-ipfs.polkadot.io",
  previewnet: "https://previewnet.substrate.dev",
};

/** Gateway used for fallback when P2P fetch fails */
export const IPFS_GATEWAY = IPFS_GATEWAYS.paseo;

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
  /** P2P fetch abort (per attempt) */
  P2P_FETCH: 30_000,
  /** Delay between P2P retry attempts */
  P2P_RETRY_DELAY: 3_000,
  /** Maximum P2P fetch retry attempts (total attempts = 1 + retries) */
  P2P_MAX_RETRIES: 2,
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
