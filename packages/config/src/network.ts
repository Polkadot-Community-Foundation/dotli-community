// Network Configuration

export const NetworkName = {
  PASEO_NEXT_V1: "paseo-next-v1",
  PASEO_NEXT_V2: "paseo-next-v2",
} as const;

export type NetworkName = (typeof NetworkName)[keyof typeof NetworkName];

export type Network = NetworkName;

export interface DotnsStorageSlots {
  readonly REGISTRY_RECORDS: number;
  readonly CONTENTHASH: number;
}

export interface DotnsContracts {
  readonly DOTNS_REGISTRY: `0x${string}`;
  readonly DOTNS_CONTENT_RESOLVER: `0x${string}`;
  readonly storageSlots: DotnsStorageSlots;
}

export interface ChainService {
  readonly genesis: string;
  readonly rpcs: readonly string[];
}

export interface BulletinService extends ChainService {
  readonly ipfsGateways: readonly string[];
}

export interface ServicesConfig {
  readonly relay: ChainService;
  readonly assethub: ChainService;
  readonly bulletin: BulletinService;
  readonly people: ChainService;
  readonly dotns: DotnsContracts;
}

export const NETWORK_NAME_TO_SERVICES_CONFIG: Record<
  NetworkName,
  ServicesConfig
> = {
  [NetworkName.PASEO_NEXT_V1]: {
    relay: {
      genesis:
        "0x77afd6190f1554ad45fd0d31aee62aacc33c6db0ea801129acb813f913e0764f",
      rpcs: [
        "wss://paseo-rpc.n.dwellir.com",
        "wss://paseo.dotters.network",
        "wss://paseo.ibp.network",
        "wss://paseo.rpc.amforc.com",
      ],
    },
    assethub: {
      genesis:
        "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2",
      rpcs: [
        "wss://asset-hub-paseo-rpc.n.dwellir.com",
        "wss://asset-hub-paseo.dotters.network",
        "wss://asset-hub-paseo.ibp.network",
        "wss://sys.turboflakes.io/asset-hub-paseo",
      ],
    },
    bulletin: {
      genesis:
        "0x744960c32e3a3df5440e1ecd4d34096f1ce2230d7016a5ada8a765d5a622b4ea",
      rpcs: [],
      ipfsGateways: ["https://paseo-ipfs.polkadot.io"],
    },
    people: {
      genesis:
        "0xa22a2424d2cbf561eaecf7da8b1b548fa9d1939f60265e942b1049616a012f71",
      rpcs: [],
    },
    dotns: {
      DOTNS_REGISTRY: "0x4Da0d37aBe96C06ab19963F31ca2DC0412057a6f",
      DOTNS_CONTENT_RESOLVER: "0x7756DF72CBc7f062e7403cD59e45fBc78bed1cD7",
      storageSlots: { REGISTRY_RECORDS: 0, CONTENTHASH: 1 },
    },
  },
  [NetworkName.PASEO_NEXT_V2]: {
    relay: {
      genesis:
        "0x77afd6190f1554ad45fd0d31aee62aacc33c6db0ea801129acb813f913e0764f",
      rpcs: [
        "wss://paseo-rpc.n.dwellir.com",
        "wss://paseo.dotters.network",
        "wss://paseo.ibp.network",
        "wss://paseo.rpc.amforc.com",
      ],
    },
    assethub: {
      genesis:
        "0x173cea9df45656cf612c8b8ece56e04e9a693c69cfaac47d3628dae735067af8",
      rpcs: ["wss://paseo-asset-hub-next-rpc.polkadot.io"],
    },
    bulletin: {
      genesis:
        "0x8cfe6717dc4becfda2e13c488a1e2061ff2dfee96e7d031157f72d36716c0a22",
      rpcs: ["wss://paseo-bulletin-next-rpc.polkadot.io"],
      ipfsGateways: ["https://paseo-bulletin-next-ipfs.polkadot.io"],
    },
    people: {
      genesis:
        "0x053e1a785bb0990b98768124d9609e963d9ca3558f5ac6e90a4297aaa0a0bd4b",
      rpcs: ["wss://paseo-people-next-system-rpc.polkadot.io"],
    },
    dotns: {
      DOTNS_REGISTRY: "0x8877344A885682523B4613779C95688ed7037BfD",
      DOTNS_CONTENT_RESOLVER: "0x2c9FF5D9136DBE5814C7B4FDbeDC15273a776663",
      storageSlots: { REGISTRY_RECORDS: 0, CONTENTHASH: 0 },
    },
  },
};

export const NETWORK_KEY = "dotli:network";

const VALID_NETWORKS: ReadonlySet<string> = new Set<Network>([
  NetworkName.PASEO_NEXT_V1,
  NetworkName.PASEO_NEXT_V2,
]);

function defaultNetwork(): Network {
  return NetworkName.PASEO_NEXT_V1;
}
let networkOverride: Network | null = null;

export function isValidNetwork(value: string): value is Network {
  return VALID_NETWORKS.has(value);
}

export function setNetworkOverride(network: Network): void {
  networkOverride = network;
}

export function getNetwork(): Network {
  if (networkOverride !== null) {
    return networkOverride;
  }
  try {
    const stored = localStorage.getItem(NETWORK_KEY);
    if (stored !== null && VALID_NETWORKS.has(stored)) {
      return stored as Network;
    }
    const computed = defaultNetwork();
    localStorage.setItem(NETWORK_KEY, computed);
    return computed;
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode, quota, disabled cookies). Non-fatal by design: readers fall back to defaults, writers drop silently. No metric — noisy on every page load.
  } catch {
    /* localStorage unavailable — intentionally non-fatal. */
  }
  return defaultNetwork();
}

export function setNetwork(network: Network): void {
  try {
    localStorage.setItem(NETWORK_KEY, network);
    // eslint-disable-next-line no-restricted-syntax
  } catch {
    /* localStorage unavailable */
  }
}

/** Full service config for the active network. */
export function getActiveServicesConfig(): ServicesConfig {
  return NETWORK_NAME_TO_SERVICES_CONFIG[getNetwork()];
}

/**
 * Genesis hashes that dApps may target on the active network. Used by the
 * protocol bridge to reject unknown chains before dispatching to smoldot.
 */
export function getActiveSupportedGenesisHashes(): Set<string> {
  const cfg = getActiveServicesConfig();
  return new Set(
    [
      cfg.relay.genesis,
      cfg.assethub.genesis,
      cfg.bulletin.genesis,
      cfg.people.genesis,
    ].map((h) => h.toLowerCase()),
  );
}
