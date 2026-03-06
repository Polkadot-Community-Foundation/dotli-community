// dot.li Universal Viewer — Configuration
// Contract addresses, chain config, peer multiaddrs, and minimal ABIs.

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
  "/dns/node1.dotspark.app/tcp/443/wss/p2p/12D3KooWQCkBm1BYtkHpocxCwMgR8yjitEeHGx8spzcDLGt2gkBm",
  "/dns/node2.dotspark.app/tcp/443/wss/p2p/12D3KooWRkZhiRhsqmrQ28rt73K7V3aCBpqKrLGSXmZ99PTcTZby",
];

// --- IPFS Gateway fallback ---

export const IPFS_GATEWAY = "https://ipfs.dotspark.app";

// --- Asset Hub Paseo public RPC (for fast gateway CID resolution) ---

export const ASSET_HUB_PASEO_RPC = ["wss://sys.ibp.network/asset-hub-paseo"];
