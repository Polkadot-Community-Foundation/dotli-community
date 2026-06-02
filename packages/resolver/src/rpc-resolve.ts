// Trusted RPC-based dotNS resolver
//
// Reads the dotNS contract storage directly from a public Asset Hub Paseo
// RPC node over WSS JSON-RPC. This trades trustlessness for speed — used
// when the user chooses gateway mode.
//
// Intentionally does NOT import from `./smoldot` so Vite can tree-shake the
// smoldot worker out of any bundle that only pulls in this module.

import { createClient, type PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { getActiveServicesConfig } from "@dotli/config/network";
import { log } from "@dotli/shared/log";
import { dur } from "@dotli/shared/perf";
import { namehash, toHex, decodeIpfsContenthashResult } from "./abi";
import {
  ContenthashDecodeError,
  UnsupportedContenthashCodecError,
} from "./errors";
import { readMappingBytes, readMappingAddress } from "./storage";
import type { StatusCallback, UnsafeApi } from "./storage";
import { readExecutableManifest, readRootManifest } from "./manifest";
import type {
  ExecutableKind,
  ExecutableManifest,
  ManifestResult,
  RootManifest,
} from "./manifest";

export type { StatusCallback } from "./storage";

/**
 * `WsJsonRpcProvider` from `polkadot-api/ws-provider` — its type is not
 * re-exported from the top-level entry point, so we derive it here.
 * Gives us `.getStatus()` which returns `{ type: "CONNECTED"|..., uri }`
 * so callers can read which node polkadot-api actually dialed (the
 * round-robin rotates on failure, so the first entry of the candidate
 * list may not be the currently answering endpoint).
 */
type WsProviderHandle = ReturnType<typeof getWsProvider>;

let clientInstance: PolkadotClient | null = null;
let apiInstance: UnsafeApi | null = null;
let clientPromise: Promise<UnsafeApi> | null = null;
let providerInstance: WsProviderHandle | null = null;

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
  // Dial a single endpoint — silent round-robin would hide which node is
  // responsible for any failure, defeating the whole point of gateway mode's
  // "trusted, deterministic" contract.
  onStatus?.(`Connecting to Asset Hub RPC...`);
  const provider = getWsProvider([...getActiveServicesConfig().assethub.rpcs], {
    // Public RPC endpoints can be tunnel-gated; the default 40s heartbeat
    // is occasionally too tight.
    heartbeatTimeout: 120_000,
  });
  providerInstance = provider;

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
    providerInstance = null;
    throw err;
  }

  onStatus?.("Connected to Asset Hub RPC");
  return apiInstance;
}

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

  onStatus?.(`Resolving "${domain}" via Trused Provider...`);
  const t0 = performance.now();

  const dotns = getActiveServicesConfig().dotns;
  const contenthashBytes = await readMappingBytes(
    api,
    dotns.DOTNS_CONTENT_RESOLVER,
    node,
    dotns.storageSlots.CONTENTHASH,
  );

  log.warn(
    `[dot.li rpc-resolve] JSON-RPC get_storage contenthash for ${domain}: ${dur(t0)}`,
  );

  if (contenthashBytes === null) {
    onStatus?.(`Domain "${domain}" not found or no content set`);
    return null;
  }

  // Mirror the smoldot-side resolver in distinguishing "not registered" /
  // "non-IPFS contenthash" / "decode error".
  const decoded = decodeIpfsContenthashResult(toHex(contenthashBytes));
  switch (decoded.kind) {
    case "ok":
      log.warn(
        `[dot.li rpc-resolve] JSON-RPC resolved ${domain} -> ${decoded.cid} (${dur(t0)})`,
      );
      onStatus?.(`Resolved "${domain}" via Trusted Provider`);
      return decoded.cid;
    case "empty":
      onStatus?.(`Domain "${domain}" not found or no content set`);
      return null;
    case "unsupported-codec":
      throw new UnsupportedContenthashCodecError(domain, decoded.codec);
    case "decode-error":
      throw new ContenthashDecodeError(domain, decoded.cause);
  }
}

/**
 * Read the executable manifest at `<kind>.<label>.dot` over the gateway
 * RPC client.
 *
 * The return shape matches the smoldot path so the host shell can branch
 * on a single discriminated union regardless of backend.
 */
export async function resolveExecutableManifestViaRpc(
  label: string,
  kind: ExecutableKind,
): Promise<ManifestResult<ExecutableManifest>> {
  const api = await ensureClient();
  const dotns = getActiveServicesConfig().dotns;
  return readExecutableManifest(api, dotns, label, kind);
}

/** Gateway-backed reader for the root manifest at `<label>.dot`. */
export async function resolveRootManifestViaRpc(
  label: string,
): Promise<ManifestResult<RootManifest>> {
  const api = await ensureClient();
  const dotns = getActiveServicesConfig().dotns;
  return readRootManifest(api, dotns, label);
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

  const dotns = getActiveServicesConfig().dotns;
  return readMappingAddress(
    api,
    dotns.DOTNS_REGISTRY,
    node,
    dotns.storageSlots.REGISTRY_RECORDS,
  );
}

/**
 * Return the Asset Hub RPC endpoint URI the shared ws-provider is
 * currently dialing, or `null` when no client has been instantiated
 * yet. The URI may not be the first entry of the candidate list —
 * polkadot-api's ws-provider rotates on failure — so callers that
 * want to display which node is actually answering (e.g. the
 * diagnostics popover) should read this instead of the config list.
 *
 * Returns `null` while in CONNECTING / ERROR / CLOSE states too, so
 * the caller can decide whether to fall back to a placeholder.
 */
export function getConnectedAssetHubRpcEndpoint(): string | null {
  if (providerInstance === null) {
    return null;
  }
  const status = providerInstance.getStatus();
  // Discriminated union: the CONNECTED and CONNECTING variants carry a
  // `uri` field, ERROR and CLOSE don't. `"uri" in status` is the
  // narrowing path that doesn't require importing the `WsEvent` enum.
  // We surface CONNECTING too so the popover shows the URI the provider
  // is currently trying, not a stale "n/a" during transient reconnects.
  if ("uri" in status) {
    return status.uri;
  }
  return null;
}

/**
 * Tear down the RPC client. Safe to call multiple times.
 */
export function destroyRpcClient(): void {
  if (clientInstance !== null) {
    try {
      clientInstance.destroy();
      // eslint-disable-next-line no-restricted-syntax -- best-effort teardown: the WS client may already be disconnected; we still clear references below.
    } catch {
      /* already dead */
    }
    clientInstance = null;
    apiInstance = null;
    providerInstance = null;
  }
}
