// dot.li — dotNS name resolution via direct storage reads
//
// Reads dotNS contract storage directly through ReviveApi.get_storage.
// No EVM execution, no ABI encoding — just raw storage slot reads.

import { getSmProvider } from "polkadot-api/sm-provider";
import { createClient, type PolkadotClient } from "polkadot-api";
import { Binary } from "polkadot-api";
import { CONTRACTS, STORAGE_SLOTS } from "@dotli/config/config";
import {
  namehash,
  computeMappingSlot,
  addToSlot,
  toHex,
  extractAddress,
  decodeBytesSlot,
  decodeIpfsContenthash,
} from "./abi";
import { dur } from "@dotli/shared/perf";
import { log } from "@dotli/shared/log";
import {
  getSmoldot,
  getRelayChain,
  extractAndSaveRelayDb,
  createResolverAssetHubChain,
  releaseResolverMutex,
  isResolverDone,
} from "./smoldot";

export { getSmoldot, getRelayChain } from "./smoldot";

export type StatusCallback = (status: string) => void;

/** Unsafe API type returned by PolkadotClient.getUnsafeApi(). */
export type UnsafeApi = ReturnType<PolkadotClient["getUnsafeApi"]>;

// ── Resolver client (temporary, destroyed after each use) ────

let clientInstance: PolkadotClient | null = null;
let apiInstance: UnsafeApi | null = null;
let ensureClientPromise: Promise<UnsafeApi> | null = null;

async function ensureClient(onStatus?: StatusCallback): Promise<UnsafeApi> {
  if (apiInstance) {
    return apiInstance;
  }
  if (ensureClientPromise) {
    return ensureClientPromise;
  }
  ensureClientPromise = doEnsureClient(onStatus).finally(() => {
    ensureClientPromise = null;
  });
  return ensureClientPromise;
}

async function doEnsureClient(onStatus?: StatusCallback): Promise<UnsafeApi> {
  // Guard: if the shared chain already exists, the resolver chain
  // cannot be created (smoldot panics on duplicate chains).
  if (isResolverDone()) {
    throw new Error(
      "Resolver unavailable: shared chain is active. " +
        "Resolution is only available before dApp chain connections.",
    );
  }

  performance.mark("dotli:smoldot:init:start");
  const initStart = performance.now();
  onStatus?.("Starting light client...");
  getSmoldot();
  log.warn(`[dot.li resolve] Smoldot instance created (${dur(initStart)})`);

  onStatus?.("Adding Paseo relay chain...");
  const relayStart = performance.now();
  const relayChain = await getRelayChain();
  log.warn(`[dot.li resolve] Relay chain added (${dur(relayStart)})`);

  onStatus?.("Adding Asset Hub Paseo...");
  const paraStart = performance.now();
  const chain = await createResolverAssetHubChain();

  try {
    const provider = getSmProvider(chain);
    clientInstance = createClient(provider);
    log.warn(
      `[dot.li resolve] Parachain added + client created (${dur(paraStart)})`,
    );

    onStatus?.("Syncing with Asset Hub Paseo...");
    const syncStart = performance.now();
    await clientInstance.getFinalizedBlock();
    log.warn(`[dot.li resolve] Synced to finalized block (${dur(syncStart)})`);

    apiInstance = clientInstance.getUnsafeApi();
    log.warn(`[dot.li resolve] ensureClient() total: ${dur(initStart)}`);
    onStatus?.("Connected to Asset Hub Paseo");
  } catch (err) {
    clientInstance?.destroy();
    clientInstance = null;
    releaseResolverMutex();
    throw err;
  }

  // Persist relay chain DB for future fast syncs
  requestIdleCallback(() => {
    void extractAndSaveRelayDb(relayChain);
  });

  return apiInstance;
}

/**
 * Destroy the resolver client and release the mutex.
 * The resolver's temporary Asset Hub chain is removed, allowing
 * chains.ts to create the shared singleton for dApp connections.
 */
export function destroyClient(): void {
  apiInstance = null;
  clientInstance?.destroy();
  clientInstance = null;
  releaseResolverMutex();
}

// ── Direct storage reads via ReviveApi.get_storage ──────────

/**
 * Extract raw bytes from a SCALE-decoded ReviveApi.get_storage result.
 */
function extractBytes(result: unknown): Uint8Array | null {
  if (result === null || result === undefined) {
    return null;
  }
  if (result instanceof Uint8Array) {
    return result;
  }
  if (typeof result !== "object") {
    return null;
  }

  const obj = result as Record<string, unknown>;
  if (typeof obj.asBytes === "function") {
    return new Uint8Array((result as Binary).asBytes());
  }
  if ("success" in obj) {
    if (obj.success !== true) {
      return null;
    }
    return extractBytes(obj.value);
  }
  if ("value" in obj) {
    return extractBytes(obj.value);
  }

  return null;
}

async function readStorageSlot(
  api: UnsafeApi,
  contractAddress: string,
  slotKey: `0x${string}`,
): Promise<Uint8Array | null> {
  const result: unknown = await api.apis.ReviveApi.get_storage(
    Binary.fromHex(contractAddress as `0x${string}`),
    Binary.fromHex(slotKey),
  );
  return extractBytes(result);
}

async function readMappingBytes(
  api: UnsafeApi,
  contractAddress: string,
  mappingKey: `0x${string}`,
  mappingSlot: number,
): Promise<Uint8Array | null> {
  const baseSlotKey = computeMappingSlot(mappingKey, mappingSlot);
  const baseData = await readStorageSlot(api, contractAddress, baseSlotKey);
  if (baseData === null) {
    return null;
  }

  const decoded = decodeBytesSlot(baseData, baseSlotKey);
  if (decoded === null) {
    return null;
  }

  if (decoded.inline) {
    return decoded.data;
  }

  const slotsNeeded = Math.ceil(decoded.length / 32);
  const result = new Uint8Array(decoded.length);

  for (let i = 0; i < slotsNeeded; i++) {
    const slotKey = addToSlot(decoded.dataSlot, i);
    const slotData = await readStorageSlot(api, contractAddress, slotKey);
    if (slotData !== null) {
      const offset = i * 32;
      const copyLen = Math.min(32, decoded.length - offset);
      result.set(slotData.slice(0, copyLen), offset);
    }
  }

  return result;
}

async function readMappingAddress(
  api: UnsafeApi,
  contractAddress: string,
  mappingKey: `0x${string}`,
  mappingSlot: number,
): Promise<string | null> {
  const slotKey = computeMappingSlot(mappingKey, mappingSlot);
  const data = await readStorageSlot(api, contractAddress, slotKey);
  if (data === null) {
    return null;
  }

  const address = extractAddress(data);
  if (address === "0x0000000000000000000000000000000000000000") {
    return null;
  }
  return address;
}

// ── Public API ──────────────────────────────────────────────

/**
 * Resolve a .dot name to an IPFS CID.
 *
 * @param label - The domain label (e.g., "myapp" for "myapp.dot")
 * @param onStatus - Optional callback for progress updates
 * @returns The IPFS CID string, or null if not found / no content set
 */
export async function resolveDotName(
  label: string,
  onStatus?: StatusCallback,
): Promise<string | null> {
  const api = await ensureClient(onStatus);

  const domain = `${label}.dot`;
  const node = namehash(domain);

  onStatus?.(`Resolving content for "${domain}"...`);
  const contentStart = performance.now();

  const contenthashBytes = await readMappingBytes(
    api,
    CONTRACTS.DOTNS_CONTENT_RESOLVER,
    node,
    STORAGE_SLOTS.CONTENTHASH,
  );
  log.warn(`[dot.li resolve] get_storage contenthash: ${dur(contentStart)}`);

  if (contenthashBytes === null) {
    onStatus?.(`Domain "${domain}" not found or no content set`);
    return null;
  }

  const cid = decodeIpfsContenthash(toHex(contenthashBytes));
  if (cid === null || cid === "") {
    onStatus?.(`Domain "${domain}" not found or no content set`);
    return null;
  }

  onStatus?.(`Resolved "${domain}" → ${cid}`);
  return cid;
}

/**
 * Resolve the owner of a .dot name.
 *
 * @param label - The domain label (e.g., "myapp" for "myapp.dot")
 * @returns The EVM address of the owner, or null if the domain doesn't exist
 */
export async function resolveOwner(label: string): Promise<string | null> {
  const api = await ensureClient();

  const domain = `${label}.dot`;
  const node = namehash(domain);

  return readMappingAddress(
    api,
    CONTRACTS.DOTNS_REGISTRY,
    node,
    STORAGE_SLOTS.REGISTRY_RECORDS,
  );
}
