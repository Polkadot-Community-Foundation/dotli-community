// dot.li — dotNS name resolution via smoldot light client
//
// Connects to Asset Hub Paseo via an in-browser light client,
// calls the dotNS contracts through the Revive runtime API,
// and returns the IPFS CID associated with a .dot name.

// Chain spec is now managed by smoldot.ts singleton
import { getSmProvider } from "polkadot-api/sm-provider";
import { createClient, type PolkadotClient } from "polkadot-api";
import { isSwSmoldotReady, getSwSmoldotProvider } from "./sw-provider";
import { Binary } from "polkadot-api";
import {
  CONTRACTS,
  DRY_RUN_WEIGHT_LIMIT,
  DRY_RUN_STORAGE_LIMIT,
  DUMMY_ORIGIN,
  TIMEOUTS,
} from "./config";
import {
  namehash,
  encodeFunctionCall,
  decodeBytes,
  decodeAddress,
  decodeIpfsContenthash,
} from "./abi";
import { dur } from "./perf";
import { log } from "./log";
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

// When true, skip trySwSmoldot() entirely — the SW was freshly registered
// and can't have smoldot ready. Avoids 500ms isSwSmoldotReady() timeout.
let freshSwRegistration = false;

/**
 * Mark the SW as freshly registered (cold start).
 * Called from main.ts when no controller existed before registration.
 */
export function markFreshSwRegistration(): void {
  freshSwRegistration = true;
}

/**
 * Try to connect via the Service Worker's smoldot instance.
 * Returns the API if the SW has smoldot ready, null otherwise.
 */
async function trySwSmoldot(
  onStatus?: StatusCallback,
): Promise<ReturnType<PolkadotClient["getUnsafeApi"]> | null> {
  try {
    if (!navigator.serviceWorker.controller) {
      return null;
    }

    // On cold start the SW was just registered — smoldot can't be ready yet.
    // Skip the isSwSmoldotReady() check to avoid the 500ms timeout.
    if (freshSwRegistration) {
      log.warn(
        "[dot.li resolve] Fresh SW registration, skipping SW smoldot check",
      );
      return null;
    }

    const ready = await isSwSmoldotReady();
    if (!ready) {
      log.warn("[dot.li resolve] SW smoldot not ready, using direct smoldot");
      return null;
    }

    performance.mark("dotli:smoldot:sw:start");
    const swStart = performance.now();
    onStatus?.("Connecting to light client (Service Worker)...");

    const provider = getSwSmoldotProvider();
    clientInstance = createClient(provider);

    onStatus?.("Syncing with Asset Hub Paseo...");
    await Promise.race([
      clientInstance.getFinalizedBlock(),
      new Promise((_resolve, reject) =>
        setTimeout(() => {
          reject(new Error("SW smoldot sync timeout"));
        }, TIMEOUTS.SW_SMOLDOT_SYNC),
      ),
    ]);
    performance.mark("dotli:smoldot:sw:end");
    log.warn(
      `[dot.li resolve] SW smoldot: synced to finalized block (${dur(swStart)})`,
    );

    apiInstance = clientInstance.getUnsafeApi();
    onStatus?.("Connected to Asset Hub Paseo (via Service Worker)");
    return apiInstance;
  } catch (err) {
    log.warn("[dot.li resolve] SW smoldot failed, falling back:", err);
    clientInstance?.destroy();
    clientInstance = null;
    return null;
  }
}

/**
 * Initialize the smoldot light client and connect to Asset Hub Paseo.
 * Tries the Service Worker's persistent smoldot first, falls back to
 * starting a new smoldot instance in the main thread.
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
  // Try SW smoldot first (persistent across navigations)
  const swApi = await trySwSmoldot(onStatus);
  if (swApi) {
    return swApi;
  }

  // Fall back to direct smoldot (main thread Web Worker)
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

/**
 * Call a Revive EVM contract (read-only dry-run).
 * Mirrors the pattern from deploy-to-dotns ReviveClientWrapper.performDryRunCall().
 */
interface ReviveExecResult {
  value?: ReviveOkResult;
  isOk?: boolean;
  ok?: ReviveOkResult;
  result?: ReviveExecResult;
}

interface ReviveOkResult {
  flags?: { toString?: () => string } | number | string;
  data?:
    | string
    | { asHex: () => string }
    | { toHex: () => string }
    | Uint8Array;
}

async function reviveCall(
  api: ReturnType<PolkadotClient["getUnsafeApi"]>,
  contractAddress: string,
  encodedData: `0x${string}`,
): Promise<`0x${string}`> {
  const result = (await api.apis.ReviveApi.call(
    DUMMY_ORIGIN,
    Binary.fromHex(contractAddress as `0x${string}`),
    0n,
    DRY_RUN_WEIGHT_LIMIT,
    DRY_RUN_STORAGE_LIMIT,
    Binary.fromHex(encodedData),
  )) as { result: ReviveExecResult };

  // Unwrap the result — same normalization as ReviveClientWrapper
  const execResult: ReviveExecResult = result.result;
  const ok: ReviveOkResult | null =
    execResult.value ??
    (execResult.isOk === true
      ? (execResult as unknown as ReviveOkResult)
      : null) ??
    execResult.ok ??
    null;

  if (ok === null) {
    throw new Error("Revive call failed: no result");
  }

  const flagsRaw = ok.flags;
  const flagsStr =
    typeof flagsRaw === "object" && typeof flagsRaw.toString === "function"
      ? flagsRaw.toString()
      : String(flagsRaw ?? 0);
  const flags = BigInt(flagsStr);
  if ((flags & 1n) === 1n) {
    throw new Error("Contract execution reverted");
  }

  // Extract return data
  const data = ok.data;
  if (typeof data === "string") {
    return data as `0x${string}`;
  }
  if (
    data !== undefined &&
    "asHex" in data &&
    typeof data.asHex === "function"
  ) {
    return data.asHex() as `0x${string}`;
  }
  if (
    data !== undefined &&
    "toHex" in data &&
    typeof data.toHex === "function"
  ) {
    return data.toHex() as `0x${string}`;
  }
  if (data instanceof Uint8Array) {
    return ("0x" +
      Array.from(data)
        .map((b: number) => b.toString(16).padStart(2, "0"))
        .join("")) as `0x${string}`;
  }
  return "0x";
}

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

  // Query the content hash directly from the ContentResolver.
  // If the domain doesn't exist, contenthash() returns empty bytes
  // which decodeIpfsContenthash() handles as null — no need for
  // a separate recordExists() call (saves ~1.7s dry-run overhead).
  onStatus?.(`Resolving content for "${domain}"...`);
  const contentCalldata = encodeFunctionCall("contenthash", node);

  const contentStart = performance.now();
  let contentResult: `0x${string}`;
  try {
    contentResult = await reviveCall(
      api,
      CONTRACTS.DOTNS_CONTENT_RESOLVER,
      contentCalldata,
    );
  } catch {
    return null;
  }

  const contenthashBytes = decodeBytes(contentResult);
  log.warn(`[dot.li resolve] contenthash() dry-run: ${dur(contentStart)}`);

  // Decode the contenthash to a CID
  const cid = decodeIpfsContenthash(contenthashBytes);
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

  const calldata = encodeFunctionCall("owner", node);

  try {
    const result = await reviveCall(api, CONTRACTS.DOTNS_REGISTRY, calldata);
    const owner = decodeAddress(result);

    // Zero address means no owner
    if (
      owner === "" ||
      owner === "0x0000000000000000000000000000000000000000"
    ) {
      return null;
    }

    return owner;
  } catch {
    return null;
  }
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
  clientInstance?.destroy();
  clientInstance = null;
  apiInstance = null;

  // Release AFTER destroy so the chain is fully removed before
  // chains.ts tries to create the shared singleton.
  releaseResolverMutex();
}
