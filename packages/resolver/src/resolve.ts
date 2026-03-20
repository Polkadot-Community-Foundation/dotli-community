// dot.li — dotNS name resolution via direct storage reads
//
// Connects to Asset Hub Paseo via an in-browser smoldot light client
// and reads dotNS contract storage directly through ReviveApi.get_storage.
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
} from "./smoldot";

export { getSmoldot, getRelayChain, releaseResolverMutex } from "./smoldot";

export type StatusCallback = (status: string) => void;

let clientInstance: PolkadotClient | null = null;
let apiInstance: ReturnType<PolkadotClient["getUnsafeApi"]> | null = null;

/**
 * Initialize the smoldot light client and connect to Asset Hub Paseo.
 * Runs smoldot in a Web Worker on the main thread. The relay chain DB
 * is persisted to IndexedDB for fast restarts on subsequent visits.
 */
let ensureClientPromise: Promise<
  ReturnType<PolkadotClient["getUnsafeApi"]>
> | null = null;

async function ensureClient(
  onStatus?: StatusCallback,
): Promise<ReturnType<PolkadotClient["getUnsafeApi"]>> {
  if (apiInstance) {
    return apiInstance;
  }

  // Deduplicate concurrent calls — only one connection attempt at a time
  if (ensureClientPromise) {
    return ensureClientPromise;
  }

  ensureClientPromise = doEnsureClient(onStatus).finally(() => {
    ensureClientPromise = null;
  });
  return ensureClientPromise;
}

async function doEnsureClient(
  onStatus?: StatusCallback,
): Promise<ReturnType<PolkadotClient["getUnsafeApi"]>> {
  performance.mark("dotli:smoldot:init:start");
  const initStart = performance.now();
  onStatus?.("Starting light client...");
  getSmoldot(); // pre-warm
  log.warn(`[dot.li resolve] Smoldot instance created (${dur(initStart)})`);

  onStatus?.("Adding Paseo relay chain...");
  performance.mark("dotli:smoldot:relay:start");
  const relayStart = performance.now();
  const relayChain = await getRelayChain();
  performance.mark("dotli:smoldot:relay:end");
  log.warn(`[dot.li resolve] Relay chain added (${dur(relayStart)})`);

  onStatus?.("Adding Asset Hub Paseo...");
  performance.mark("dotli:smoldot:parachain:start");
  const paraStart = performance.now();
  const chain = await createResolverAssetHubChain();

  // Once the dedicated chain exists, any failure must destroy it and
  // release the mutex so chains.ts is not blocked forever.
  try {
    const provider = getSmProvider(chain);
    clientInstance = createClient(provider);
    performance.mark("dotli:smoldot:parachain:end");
    log.warn(
      `[dot.li resolve] Parachain added + client created (${dur(paraStart)})`,
    );

    onStatus?.("Syncing with Asset Hub Paseo...");
    performance.mark("dotli:smoldot:sync:start");
    const syncStart = performance.now();
    await clientInstance.getFinalizedBlock();
    performance.mark("dotli:smoldot:sync:end");
    log.warn(`[dot.li resolve] Synced to finalized block (${dur(syncStart)})`);

    apiInstance = clientInstance.getUnsafeApi();
    performance.mark("dotli:smoldot:init:end");
    log.warn(`[dot.li resolve] ensureClient() total: ${dur(initStart)}`);
    onStatus?.("Connected to Asset Hub Paseo");
  } catch (err) {
    // Tear down the dedicated chain and release the mutex so chains.ts
    // can still create the shared singleton.
    clientInstance?.destroy();
    clientInstance = null;
    releaseResolverMutex();
    throw err;
  }

  // Persist relay chain DB for future fast syncs (yield to rendering first)
  requestIdleCallback(() => {
    void extractAndSaveRelayDb(relayChain);
  });

  return apiInstance;
}

// ── Direct storage reads via ReviveApi.get_storage ──────────
//
// Reads contract storage slots directly without executing EVM code.
// get_storage(address, key) reads from the contract's child trie
// and returns the raw 32-byte storage value.

type UnsafeApi = ReturnType<PolkadotClient["getUnsafeApi"]>;

/**
 * Extract raw bytes from a SCALE-decoded ReviveApi.get_storage result.
 * The result shape varies by polkadot-api version, so we probe defensively.
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

  // Binary from polkadot-api
  const obj = result as Record<string, unknown>;
  if (typeof obj.asBytes === "function") {
    return new Uint8Array((result as Binary).asBytes());
  }

  // { success: true, value: ... }
  if ("success" in obj) {
    if (obj.success !== true) {
      return null;
    }
    return extractBytes(obj.value);
  }

  // { type: "Some", value: ... }
  if ("value" in obj) {
    return extractBytes(obj.value);
  }

  return null;
}

/**
 * Read a single 32-byte storage slot from a Revive contract.
 *
 * Uses ReviveApi.get_storage which reads directly from the contract's
 * child trie — no EVM execution, no ABI encoding.
 *
 * Returns the raw 32-byte value, or null if the slot is empty
 * or the contract doesn't exist.
 */
async function readStorageSlot(
  api: UnsafeApi,
  contractAddress: string,
  slotKey: `0x${string}`,
): Promise<Uint8Array | null> {
  const result: unknown = await api.apis.ReviveApi.get_storage(
    Binary.fromHex(contractAddress as `0x${string}`),
    Binary.fromHex(slotKey),
  );

  // The SCALE-decoded Result<Option<Vec<u8>>> may appear in several shapes
  // depending on polkadot-api version. Handle them all defensively.
  return extractBytes(result);
}

/**
 * Read a Solidity `bytes` value from a mapping in contract storage.
 *
 * Handles both inline (≤ 31 bytes) and multi-slot (> 31 bytes) encoding.
 * ENS contenthash values are typically 36-38 bytes, so they use the
 * multi-slot path: base slot has the length, data at keccak256(base).
 */
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

  // Long bytes: read consecutive data slots
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

/**
 * Read a Solidity `address` from a mapping in contract storage.
 *
 * The address is stored right-aligned in a 32-byte word.
 */
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
 * Reads the contenthash directly from the ContentResolver contract's
 * storage via ReviveApi.get_storage — no EVM execution.
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
 * Reads the owner address directly from the Registry contract's
 * storage via ReviveApi.get_storage — no EVM execution.
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

/**
 * Destroy the light client (cleanup).
 * destroy() disconnects the provider, which calls chain.remove() —
 * this fully removes the resolver's dedicated Asset Hub chain from smoldot.
 *
 * Then releases the resolver mutex so chains.ts can create the shared
 * Asset Hub singleton (smoldot panics on double-addChain).
 */
export function destroyClient(): void {
  apiInstance = null;
  clientInstance?.destroy();
  clientInstance = null;

  // Release AFTER destroy so the chain is fully removed before
  // chains.ts tries to create the shared singleton.
  releaseResolverMutex();
}
