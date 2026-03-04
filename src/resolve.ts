// dot.li — dotNS name resolution via smoldot light client
//
// Connects to Asset Hub Paseo via an in-browser light client,
// calls the dotNS contracts through the Revive runtime API,
// and returns the IPFS CID associated with a .dot name.

import { startFromWorker } from "polkadot-api/smoldot/from-worker";
import SmWorker from "polkadot-api/smoldot/worker?worker";
import { chainSpec as paseoChainSpec } from "polkadot-api/chains/paseo";
import { chainSpec as assetHubPaseoChainSpec } from "polkadot-api/chains/paseo_asset_hub";
import { getSmProvider } from "polkadot-api/sm-provider";
import { createClient, type PolkadotClient } from "polkadot-api";
import { Binary } from "polkadot-api";
import { namehash, encodeFunctionData, decodeFunctionResult } from "viem";
import {
  decode as decodeContentHash,
  getCodec,
} from "@ensdomains/content-hash";
import {
  CONTRACTS,
  CONTENT_RESOLVER_ABI,
  REGISTRY_ABI,
  DRY_RUN_WEIGHT_LIMIT,
  DRY_RUN_STORAGE_LIMIT,
  DUMMY_ORIGIN,
} from "./config";

export type StatusCallback = (status: string) => void;

// Shared smoldot instance and relay chain — reused by chain provider factory
let smoldotInstance: ReturnType<typeof startFromWorker> | null = null;
let relayChainPromise: Promise<
  Awaited<ReturnType<ReturnType<typeof startFromWorker>["addChain"]>>
> | null = null;

/**
 * Get or create the shared smoldot instance.
 */
export function getSmoldot(): ReturnType<typeof startFromWorker> {
  smoldotInstance ??= startFromWorker(new SmWorker());
  return smoldotInstance;
}

/**
 * Get or create the Paseo relay chain (needed as potentialRelayChain for parachains).
 */
export function getRelayChain(): Promise<
  Awaited<ReturnType<ReturnType<typeof startFromWorker>["addChain"]>>
> {
  relayChainPromise ??= getSmoldot().addChain({ chainSpec: paseoChainSpec });
  return relayChainPromise;
}

let clientInstance: PolkadotClient | null = null;
let apiInstance: ReturnType<PolkadotClient["getUnsafeApi"]> | null = null;

/**
 * Initialize the smoldot light client and connect to Asset Hub Paseo.
 * Returns when the chain is synced and ready for queries.
 */
async function ensureClient(
  onStatus?: StatusCallback,
): Promise<ReturnType<PolkadotClient["getUnsafeApi"]>> {
  if (apiInstance) {
    return apiInstance;
  }

  performance.mark("dotli:smoldot:init:start");
  onStatus?.("Starting light client...");
  const smoldot = getSmoldot();

  onStatus?.("Adding Paseo relay chain...");
  performance.mark("dotli:smoldot:relay:start");
  const relayChain = await getRelayChain();
  performance.mark("dotli:smoldot:relay:end");

  onStatus?.("Adding Asset Hub Paseo...");
  performance.mark("dotli:smoldot:parachain:start");
  const chain = smoldot.addChain({
    chainSpec: assetHubPaseoChainSpec,
    potentialRelayChains: [relayChain],
  });

  const provider = getSmProvider(chain);
  clientInstance = createClient(provider);
  performance.mark("dotli:smoldot:parachain:end");

  onStatus?.("Syncing with Asset Hub Paseo...");
  performance.mark("dotli:smoldot:sync:start");
  await clientInstance.getFinalizedBlock();
  performance.mark("dotli:smoldot:sync:end");

  apiInstance = clientInstance.getUnsafeApi();
  performance.mark("dotli:smoldot:init:end");
  onStatus?.("Connected to Asset Hub Paseo");
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
 * Decode contenthash bytes (from the DotnsContentResolver) into an IPFS CID string.
 * Uses @ensdomains/content-hash (same as deploy-to-dotns CLI).
 */
function decodeIpfsContenthash(contenthashHex: string): string | null {
  const hex = contenthashHex.startsWith("0x")
    ? contenthashHex.slice(2)
    : contenthashHex;
  if (!hex || hex === "0" || hex.length < 4) {
    return null;
  }

  try {
    const codec = getCodec(hex);
    if (codec !== "ipfs") {
      return null;
    }
    return decodeContentHash(hex);
  } catch {
    return null;
  }
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

  // Step 1: Check if the domain exists in the registry
  onStatus?.(`Checking if "${domain}" exists...`);
  const existsCalldata = encodeFunctionData({
    abi: REGISTRY_ABI,
    functionName: "recordExists",
    args: [node],
  });

  const existsResult = await reviveCall(
    api,
    CONTRACTS.DOTNS_REGISTRY,
    existsCalldata,
  );
  const exists = decodeFunctionResult({
    abi: REGISTRY_ABI,
    functionName: "recordExists",
    data: existsResult,
  }) as unknown as boolean;

  if (!exists) {
    onStatus?.(`Domain "${domain}" not found`);
    return null;
  }

  // Step 2: Query the content hash from the ContentResolver
  onStatus?.(`Resolving content for "${domain}"...`);
  const contentCalldata = encodeFunctionData({
    abi: CONTENT_RESOLVER_ABI,
    functionName: "contenthash",
    args: [node],
  });

  const contentResult = await reviveCall(
    api,
    CONTRACTS.DOTNS_CONTENT_RESOLVER,
    contentCalldata,
  );

  const contenthashBytes = decodeFunctionResult({
    abi: CONTENT_RESOLVER_ABI,
    functionName: "contenthash",
    data: contentResult,
  }) as unknown as `0x${string}`;

  // Step 3: Decode the contenthash to a CID
  const cid = decodeIpfsContenthash(contenthashBytes);
  if (cid === null || cid === "") {
    onStatus?.(`No content set for "${domain}"`);
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

  const calldata = encodeFunctionData({
    abi: REGISTRY_ABI,
    functionName: "owner",
    args: [node],
  });

  try {
    const result = await reviveCall(api, CONTRACTS.DOTNS_REGISTRY, calldata);
    const owner = decodeFunctionResult({
      abi: REGISTRY_ABI,
      functionName: "owner",
      data: result,
    }) as unknown as string;

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
 */
export function destroyClient(): void {
  clientInstance?.destroy();
  clientInstance = null;
  apiInstance = null;
}
