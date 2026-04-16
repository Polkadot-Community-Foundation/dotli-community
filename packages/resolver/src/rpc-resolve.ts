// dot.li — Trusted RPC-based dotNS resolver
//
// Reads the dotNS contract storage directly from a public Asset Hub Paseo
// RPC node over WSS JSON-RPC. This trades trustlessness for speed — used
// when the user chooses gateway mode.
//
// Intentionally does NOT import from `./smoldot` so Vite can tree-shake the
// smoldot worker out of any bundle that only pulls in this module.

import { createClient, type PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider";
import {
  ASSET_HUB_PASEO_RPC_ENDPOINTS,
  CONTRACTS,
  STORAGE_SLOTS,
} from "@dotli/config/config";
import { log } from "@dotli/shared/log";
import { dur } from "@dotli/shared/perf";
import { namehash, toHex, decodeIpfsContenthash } from "./abi";
import { readMappingBytes, readMappingAddress } from "./storage";
import type { StatusCallback, UnsafeApi } from "./storage";

export type { StatusCallback } from "./storage";

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
  const t0 = performance.now();
  onStatus?.("Connecting to Asset Hub RPC...");

  const provider = getWsProvider([...ASSET_HUB_PASEO_RPC_ENDPOINTS], {
    // Public RPC endpoints can be tunnel-gated; the default 40s heartbeat
    // is occasionally too tight.
    heartbeatTimeout: 120_000,
  });

  clientInstance = createClient(provider);
  apiInstance = clientInstance.getUnsafeApi();

  // Touch the finalized block so the client performs its initial metadata
  // exchange before we issue runtime API calls — surfaces connection errors
  // early and makes subsequent get_storage calls warm.
  try {
    const block = await clientInstance.getFinalizedBlock();
    log.warn(
      `[dot.li rpc-resolve] Connected to RPC, finalized #${String(block.number)} (${dur(t0)})`,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`[dot.li rpc-resolve] RPC connection failed: ${message}`);
    // Reset state so the next call can retry a fresh client.
    clientInstance = null;
    apiInstance = null;
    throw err;
  }

  onStatus?.("Connected to Asset Hub RPC");
  return apiInstance;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Resolve a `.dot` label to an IPFS CID by reading dotNS contract storage
 * directly over JSON-RPC (bypassing smoldot).
 *
 * This is the "trusted gateway" path — a normal client-server request to
 * a known Polkadot RPC node instead of running a light client in-browser.
 */
export async function resolveDotNameViaRpc(
  label: string,
  onStatus?: StatusCallback,
): Promise<string | null> {
  log.warn(
    `[dot.li rpc-resolve] resolving ${label}.dot via JSON-RPC (trusted node, smoldot bypassed)`,
  );
  const api = await ensureClient(onStatus);

  const domain = `${label}.dot`;
  const node = namehash(domain);

  onStatus?.(`Resolving "${domain}" via RPC...`);
  const t0 = performance.now();

  const contenthashBytes = await readMappingBytes(
    api,
    CONTRACTS.DOTNS_CONTENT_RESOLVER,
    node,
    STORAGE_SLOTS.CONTENTHASH,
  );

  log.warn(
    `[dot.li rpc-resolve] JSON-RPC get_storage contenthash for ${domain}: ${dur(t0)}`,
  );

  if (contenthashBytes === null) {
    onStatus?.(`Domain "${domain}" not found or no content set`);
    return null;
  }

  const cid = decodeIpfsContenthash(toHex(contenthashBytes));
  if (cid === null || cid === "") {
    onStatus?.(`Domain "${domain}" not found or no content set`);
    return null;
  }

  log.warn(
    `[dot.li rpc-resolve] JSON-RPC resolved ${domain} -> ${cid} (${dur(t0)})`,
  );
  onStatus?.(`Resolved "${domain}" via RPC`);
  return cid;
}

/**
 * Resolve the owner address of a `.dot` label by reading the dotNS registry
 * contract storage over JSON-RPC.
 */
export async function resolveOwnerViaRpc(
  label: string,
): Promise<string | null> {
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
 * Tear down the RPC client. Safe to call multiple times.
 */
export function destroyRpcClient(): void {
  if (clientInstance !== null) {
    try {
      clientInstance.destroy();
    } catch {
      /* already dead */
    }
    clientInstance = null;
    apiInstance = null;
  }
}
