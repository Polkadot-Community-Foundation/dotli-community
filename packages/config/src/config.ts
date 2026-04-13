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

// SiteId is the registrable root domain the shell is running on (e.g. "dot.li",
// "paseo.li", "paseoli.dev"). It is a plain string — there is no closed union,
// because the codebase is deployed on several root domains including ephemeral
// ones, and a narrow union here would require an unsafe cast at the boundary.
// Validation that a caller may only use the current shell's SiteId lives in
// `@dotli/protocol/auth-storage#isSharedAuthSiteId`, which compares against the
// running `SITE_ID` at runtime.
export type SiteId = string;

export const isLocalhost =
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "127.0.0.1";

export const SITE_ID: SiteId = isLocalhost ? "local.li" : BASE_DOMAIN;

// --- Debug logging -------------------------------------------------------

export const DEBUG =
  (import.meta.env.VITE_APP_DEBUG as string | undefined) !== "false";

// --- Well-known genesis hashes (Paseo testnet) ---

export const PASEO_RELAY_GENESIS =
  "0x77afd6190f1554ad45fd0d31aee62aacc33c6db0ea801129acb813f913e0764f" as const;
export const ASSET_HUB_PASEO_GENESIS =
  "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2" as const;
export const BULLETIN_PASEO_GENESIS =
  "0x744960c32e3a3df5440e1ecd4d34096f1ce2230d7016a5ada8a765d5a622b4ea" as const;

export const SUPPORTED_GENESIS_HASHES = new Set<string>([
  PASEO_RELAY_GENESIS,
  ASSET_HUB_PASEO_GENESIS,
  BULLETIN_PASEO_GENESIS,
]);

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

// --- IPFS Gateway ---

/** Gateway used for fallback when P2P fetch fails */
export const IPFS_GATEWAY = "https://paseo-ipfs.polkadot.io";

// --- SW archive cache ---

/** Max number of domain archives kept in the SW in-memory LRU cache. */
export const SW_ARCHIVE_CACHE_MAX = 8;

/** Max chain connections per origin on the protocol host. */
export const MAX_CONNECTIONS_PER_ORIGIN = 3;

/** Max nested container bridges per host shell. */
export const MAX_NESTED_BRIDGES = 5;

// --- Timeouts (ms) ---

export const TIMEOUTS = {
  /** SW cache lookup before falling through */
  SW_CACHE_LOOKUP: 3_000,
  /** Waiting for SW controllerchange after registration */
  SW_READY: 10_000,
  /** P2P fetch abort (per attempt) */
  P2P_FETCH: 30_000,
  /** Delay before starting gateway fetch in parallel with P2P */
  P2P_RACE_GATEWAY_DELAY: 5_000,
  /** SharedWorker readiness timeout (must cover full cold-start chain sync, up to ~60s) */
  SHARED_WORKER_READY: 90_000,
} as const;
