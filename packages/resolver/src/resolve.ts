// dot.li — dotNS name resolution via direct storage reads
//
// Uses polkadot-api with the shared Asset Hub provider from smoldot.ts.

import { createClient, type PolkadotClient } from "polkadot-api";
import { CONTRACTS, STORAGE_SLOTS, TIMEOUTS } from "@dotli/config/config";
import { namehash, toHex, decodeIpfsContenthashResult } from "./abi";
import { dur } from "@dotli/shared/perf";
import { log } from "@dotli/shared/log";
import {
  getSmoldot,
  getRelayChain,
  getResolverAssetHubProvider,
  onConnectionIssue,
  onSmoldotFatal,
} from "./smoldot";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import { readMappingBytes, readMappingAddress } from "./storage";
import type { PhaseCallback, StatusCallback, UnsafeApi } from "./storage";

export type { StatusCallback, PhaseCallback, ResolvePhase } from "./storage";
export { statusToPhase } from "./storage";
export { getSmoldot, getSmoldotDirect, getRelayChain } from "./smoldot";
export { onConnectionIssue } from "./smoldot";

// ── Client lifecycle ─────────────────────────────────────────

let clientInstance: PolkadotClient | null = null;
let apiInstance: UnsafeApi | null = null;
let clientPromise: Promise<UnsafeApi> | null = null;
let fatalUnsubscribe: (() => void) | null = null;

/**
 * Tear down the cached resolver client. Callers that hold a reference to
 * `apiInstance` must discard it — every subsequent `.` resolution will
 * rebuild against a fresh smoldot chain.
 *
 * Used by:
 *   - `onSmoldotFatal` to clear stale references after a WASM panic so
 *     the next `resolveDotName` doesn't hand the caller a dead client.
 *   - Config changes (chain backend switch) that require a new client.
 */
export function destroyResolverClient(): void {
  if (clientInstance !== null) {
    log.warn("[dot.li resolve] Destroying resolver client");
    try {
      clientInstance.destroy();
      // eslint-disable-next-line no-restricted-syntax -- best-effort teardown: if smoldot already panicked the client may throw; we still must clear our references below so the next ensureClient() starts fresh.
    } catch {
      /* already dead — clear references anyway */
    }
  }
  clientInstance = null;
  apiInstance = null;
  clientPromise = null;
}

/**
 * Register a one-shot listener against `onSmoldotFatal` so a WASM panic
 * clears the cached client before any subsequent `resolveDotName` runs.
 * Without this, the next caller would receive `apiInstance` pointing at
 * a client whose upstream chain is dead and hang indefinitely.
 */
function ensureFatalListener(): void {
  if (fatalUnsubscribe !== null) {
    return;
  }
  fatalUnsubscribe = onSmoldotFatal((message) => {
    log.error(`[dot.li resolve] Smoldot fatal — clearing client: ${message}`);
    destroyResolverClient();
  });
}

function ensureClient(
  onStatus?: StatusCallback,
  onPhase?: PhaseCallback,
): Promise<UnsafeApi> {
  ensureFatalListener();
  if (apiInstance !== null) {
    // Already synced — emit the terminal phase so a late subscriber
    // still sees an accurate snapshot instead of staying on whatever
    // the previous phase was.
    onPhase?.("asset-hub-ready");
    return Promise.resolve(apiInstance);
  }
  if (clientPromise !== null) {
    return clientPromise;
  }
  clientPromise = doCreateClient(onStatus, onPhase).finally(() => {
    clientPromise = null;
  });
  return clientPromise;
}

async function doCreateClient(
  onStatus?: StatusCallback,
  onPhase?: PhaseCallback,
): Promise<UnsafeApi> {
  const initStart = performance.now();
  const stopPresync = m.timer(S.SMOLDOT_PRESYNC);

  // Forward bootnode drops to the loading UI. Counter is throttled to
  // 1/sec because cold sync can fail hundreds of handshakes per second.
  let lastBootnodeMetricAt = 0;
  const unsubConnectionIssue = onConnectionIssue((msg) => {
    onStatus?.(`Bootnode connection issue, ${msg}`);
    const now = performance.now();
    if (now - lastBootnodeMetricAt >= 1000) {
      lastBootnodeMetricAt = now;
      m.count(S.BOOTNODE_ERROR, { source: "log-callback" });
    }
  });

  try {
    onPhase?.("light-client-starting");
    onStatus?.("Starting light client...");
    m.span(S.SMOLDOT_CREATE, () => {
      getSmoldot();
    });
    log.warn(`[dot.li resolve] Smoldot instance created (${dur(initStart)})`);

    onPhase?.("relay-chain-adding");
    onStatus?.("Adding Paseo relay chain...");
    const relayStart = performance.now();
    await m.span(S.SMOLDOT_RELAY_CHAIN, () => getRelayChain());
    m.measure(S.SMOLDOT_RELAY_CHAIN, performance.now() - relayStart);
    log.warn(`[dot.li resolve] Relay chain added (${dur(relayStart)})`);

    onPhase?.("asset-hub-connecting");
    onStatus?.("Connecting to Asset Hub Paseo...");
    const provider = getResolverAssetHubProvider();
    log.warn("[dot.li resolve] Creating polkadot-api client...");
    const newClient = createClient(provider);

    onPhase?.("asset-hub-syncing");
    onStatus?.("Syncing with Asset Hub Paseo...");
    const syncStart = performance.now();
    // Assign `clientInstance` only AFTER the finalized-block wait
    // succeeds. If `getFinalizedBlock` throws, we destroy the local
    // client immediately — leaving an orphaned client behind would
    // silently keep a smoldot chain subscription alive, and the next
    // `ensureClient()` call would still see `apiInstance === null` and
    // loop on the same dead provider.
    //
    // Bound the wait: without the race, an unreachable peer set leaves
    // `getFinalizedBlock()` pending forever and the UI sits on the
    // "Syncing…" overlay indefinitely. The timeout throws so the
    // outer catch can surface a visible error via `showError`.
    try {
      const block = await m.span(S.SMOLDOT_FINALIZED_BLOCK, () =>
        Promise.race([
          newClient.getFinalizedBlock(),
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(
                new Error(
                  `Sync to Asset Hub Paseo timed out after ${String(TIMEOUTS.ASSET_HUB_FINALIZED_SYNC / 1000)}s — unable to reach peers`,
                ),
              );
            }, TIMEOUTS.ASSET_HUB_FINALIZED_SYNC);
          }),
        ]),
      );
      const syncMs = performance.now() - syncStart;
      m.measure(S.SMOLDOT_FINALIZED_BLOCK, syncMs);
      m.distribution(S.SMOLDOT_FINALIZED_BLOCK, syncMs);
      log.warn(
        `[dot.li resolve] Synced to finalized block #${String(block.number)} (${dur(syncStart)})`,
      );
    } catch (err) {
      try {
        newClient.destroy();
        // eslint-disable-next-line no-restricted-syntax -- best-effort teardown of a never-fully-initialised client; the real cause is rethrown on the next line.
      } catch {
        /* already dead — real cause rethrown below */
      }
      throw err;
    }

    clientInstance = newClient;
    apiInstance = clientInstance.getUnsafeApi();
    stopPresync();
    log.warn(`[dot.li resolve] Ready (${dur(initStart)} total)`);
    onPhase?.("asset-hub-ready");
    onStatus?.("Connected to Asset Hub Paseo");
    return apiInstance;
  } finally {
    unsubConnectionIssue();
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Presync primitive used by the SharedWorker / direct-mode bootstrap.
 *
 * The same work that `resolveDotName` does under the hood — spin up
 * smoldot, add relay chain, add Asset Hub, wait for first finalized
 * block — minus the name resolution step. Exposing it as a named
 * function means the protocol-shared-worker can say "I want to be
 * ready" instead of calling `resolveDotName("__presync__")` and
 * relying on the resolver to special-case the sentinel label. The old
 * approach coupled presync to whatever the resolver happened to do
 * with unknown labels; this decouples them.
 */
export async function waitForAssetHubFinalized(
  onStatus?: StatusCallback,
  onPhase?: PhaseCallback,
): Promise<void> {
  await ensureClient(onStatus, onPhase);
}

export async function resolveDotName(
  label: string,
  onStatus?: StatusCallback,
  onPhase?: PhaseCallback,
): Promise<string | null> {
  const api = await ensureClient(onStatus, onPhase);

  const domain = `${label}.dot`;
  const node = namehash(domain);

  onPhase?.("resolving-content");
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

  // The contenthash decoder returns a discriminated result so we can tell
  // the user why we failed instead of conflating "no record" / "wrong
  // codec" / "decode error".
  const decoded = decodeIpfsContenthashResult(toHex(contenthashBytes));
  switch (decoded.kind) {
    case "ok":
      onStatus?.(`Resolved "${domain}" → ${decoded.cid}`);
      return decoded.cid;
    case "empty":
      onStatus?.(`Domain "${domain}" not found or no content set`);
      return null;
    case "unsupported-codec":
      throw new Error(
        `Domain "${domain}" has a non-IPFS contenthash (codec=${decoded.codec ?? "unknown"})`,
      );
    case "decode-error": {
      const cause = decoded.cause;
      throw new Error(
        `Failed to decode contenthash for "${domain}": ${cause instanceof Error ? cause.message : String(cause)}`,
        cause instanceof Error ? { cause } : undefined,
      );
    }
  }
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
