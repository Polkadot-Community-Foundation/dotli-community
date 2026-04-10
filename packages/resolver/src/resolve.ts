// dot.li — dotNS name resolution via direct storage reads
//
// Uses polkadot-api with the shared Asset Hub provider from smoldot.ts.

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
  getResolverAssetHubProvider,
  onConnectionIssue,
} from "./smoldot";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";

export { getSmoldot, getSmoldotDirect, getRelayChain } from "./smoldot";
export { onConnectionIssue } from "./smoldot";

export type StatusCallback = (status: string) => void;
type UnsafeApi = ReturnType<PolkadotClient["getUnsafeApi"]>;

// ── Client lifecycle ─────────────────────────────────────────

let clientInstance: PolkadotClient | null = null;
let apiInstance: UnsafeApi | null = null;
let clientPromise: Promise<UnsafeApi> | null = null;

function ensureClient(onStatus?: StatusCallback): Promise<UnsafeApi> {
  if (apiInstance !== null) {
    return Promise.resolve(apiInstance);
  }
  if (clientPromise !== null) {
    return clientPromise;
  }
  clientPromise = doCreateClient(onStatus).finally(() => {
    clientPromise = null;
  });
  return clientPromise;
}

async function doCreateClient(onStatus?: StatusCallback): Promise<UnsafeApi> {
  const initStart = performance.now();
  const stopPresync = m.timer(S.SMOLDOT_PRESYNC);

  // Forward smoldot connection issues to the status callback so the
  // loading UI can surface bootnode drops to the user.
  const unsubConnectionIssue = onConnectionIssue((msg) => {
    onStatus?.(`Bootnode connection issue — ${msg}`);
    m.count(S.BOOTNODE_ERROR, { source: "log_callback" });
  });

  try {
    onStatus?.("Starting light client...");
    m.span(S.SMOLDOT_CREATE, () => {
      getSmoldot();
    });
    log.warn(`[dot.li resolve] Smoldot instance created (${dur(initStart)})`);

    onStatus?.("Adding Paseo relay chain...");
    const relayStart = performance.now();
    await m.span(S.SMOLDOT_RELAY_CHAIN, () => getRelayChain());
    m.measure(S.SMOLDOT_RELAY_CHAIN, performance.now() - relayStart);
    log.warn(`[dot.li resolve] Relay chain added (${dur(relayStart)})`);

    onStatus?.("Connecting to Asset Hub Paseo...");
    const provider = getResolverAssetHubProvider();
    log.warn("[dot.li resolve] Creating polkadot-api client...");
    clientInstance = createClient(provider);

    onStatus?.("Syncing with Asset Hub Paseo...");
    const syncStart = performance.now();
    // clientInstance is guaranteed non-null — assigned on the line above
    const client = clientInstance;
    const block = await m.span(S.SMOLDOT_FINALIZED_BLOCK, () =>
      client.getFinalizedBlock(),
    );
    const syncMs = performance.now() - syncStart;
    m.measure(S.SMOLDOT_FINALIZED_BLOCK, syncMs);
    m.distribution(S.SMOLDOT_FINALIZED_BLOCK, syncMs);
    log.warn(
      `[dot.li resolve] Synced to finalized block #${String(block.number)} (${dur(syncStart)})`,
    );

    apiInstance = clientInstance.getUnsafeApi();
    stopPresync();
    log.warn(`[dot.li resolve] Ready (${dur(initStart)} total)`);
    onStatus?.("Connected to Asset Hub Paseo");
    return apiInstance;
  } finally {
    unsubConnectionIssue();
  }
}

// ── Storage reads ────────────────────────────────────────────

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
  // Use at:"best" to read from the latest block, not the finalized block.
  // During cold sync, the finalized block may be behind the chain tip.
  const result: unknown = await api.apis.ReviveApi.get_storage(
    Binary.fromHex(contractAddress as `0x${string}`),
    Binary.fromHex(slotKey),
    { at: "best" },
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

// ── Public API ───────────────────────────────────────────────

export async function resolveDotName(
  label: string,
  onStatus?: StatusCallback,
): Promise<string | null> {
  const api = await ensureClient(onStatus);

  const domain = `${label}.dot`;
  const node = namehash(domain);

  onStatus?.(`Resolving content for "${domain}"...`);
  const contentStart = performance.now();

  const contenthashBytes = await m.span(S.RESOLVE_STORAGE_READ, () =>
    readMappingBytes(
      api,
      CONTRACTS.DOTNS_CONTENT_RESOLVER,
      node,
      STORAGE_SLOTS.CONTENTHASH,
    ),
  );
  m.measure(S.RESOLVE_STORAGE_READ, performance.now() - contentStart);
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
