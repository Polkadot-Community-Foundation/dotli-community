// dot.li — Smoldot lifecycle management
//
// Single shared smoldot instance plus a small set of provider factories.
// The protocol host can override the resolver's Asset Hub provider so
// `.dot` resolution and remote dApp clients share one upstream JSON-RPC
// loop through a broker.
//
// Chain DB persistence is handled by smoldot internally — we do NOT
// manually save/load chain databases to IndexedDB.

import { start as startSmoldotDirect } from "polkadot-api/smoldot";
import { startFromWorker } from "polkadot-api/smoldot/from-worker";
import SmWorker from "polkadot-api/smoldot/worker?worker";
import {
  getPaseoChainSpec,
  getAssetHubPaseoChainSpec,
  getBulletinPaseoChainSpec,
  getPeopleChainSpec,
  getCustomRelayChainSpec,
} from "./chain-specs";
import { getSmProvider } from "polkadot-api/sm-provider";
import type { JsonRpcProvider } from "polkadot-api";
import { log } from "@dotli/shared/log";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";

/** The smoldot Client type (shared by `start()` and `startFromWorker()`). */
export type SmoldotClient = ReturnType<typeof startFromWorker>;

export type SmoldotChain = Awaited<ReturnType<SmoldotClient["addChain"]>>;

// ── Connection issue detection ───────────────────────────────
//
// Smoldot's logCallback fires for all internal events. We watch for
// connection-related errors/warnings and notify subscribers so the UI
// can surface bootnode issues to the user.

type ConnectionIssueCallback = (message: string) => void;
const connectionIssueListeners = new Set<ConnectionIssueCallback>();

/**
 * Subscribe to smoldot connection issues (bootnode drops, timeouts, etc.).
 * Returns an unsubscribe function.
 */
export function onConnectionIssue(cb: ConnectionIssueCallback): () => void {
  connectionIssueListeners.add(cb);
  return () => {
    connectionIssueListeners.delete(cb);
  };
}

// ── Fatal panic detection ────────────────────────────────────
//
// Smoldot's WASM can panic (e.g. the "Option::unwrap() on a None value"
// crash during relay-chain sync). A panic leaves every chain dead — any
// in-flight request would hang forever. The log callback catches the
// panic line so the surrounding layers can broadcast a fatal signal out
// to the host client and reject pending requests immediately instead of
// relying on a per-request timeout.

type FatalCallback = (message: string) => void;
const fatalListeners = new Set<FatalCallback>();
let smoldotFatalMessage: string | null = null;

export function onSmoldotFatal(cb: FatalCallback): () => void {
  fatalListeners.add(cb);
  // Replay the panic message for listeners registered after the crash so
  // a late subscriber still sees the failure instead of silently waiting.
  if (smoldotFatalMessage !== null) {
    try {
      cb(smoldotFatalMessage);
      // eslint-disable-next-line no-restricted-syntax -- defensive multicast replay: one buggy late subscriber must not prevent the caller from registering.
    } catch {
      /* listener threw — safe to ignore on replay */
    }
  }
  return () => {
    fatalListeners.delete(cb);
  };
}

function markSmoldotFatal(message: string): void {
  if (smoldotFatalMessage !== null) {
    return;
  }
  smoldotFatalMessage = message;
  for (const cb of fatalListeners) {
    try {
      cb(message);
      // eslint-disable-next-line no-restricted-syntax -- defensive multicast: one buggy subscriber must not block the fatal broadcast to all others.
    } catch {
      /* listener threw — don't let one listener break the broadcast */
    }
  }
}

// Patterns that indicate a bootnode or peer connection problem.
const CONNECTION_ISSUE_PATTERNS = [
  "reset by remote",
  "refused",
  "closed",
  "timeout",
  "no longer reachable",
  "handshake",
  "all bootnodes",
];

function smoldotLogCallback(
  level: number,
  target: string,
  message: string,
): void {
  // Level 1 = Error, 2 = Warn, 3 = Info, 4 = Debug, 5 = Trace
  if (level <= 2) {
    log.warn(`[smoldot:${target}] ${message}`);
  } else {
    log.debug(`[smoldot:${target}] ${message}`);
  }

  // Panic — terminal, no recovery. Smoldot's log message starts with
  // "Smoldot has panicked while executing task …". Surface as fatal.
  if (
    message.includes("Smoldot has panicked") ||
    message.includes("panicked at")
  ) {
    markSmoldotFatal(message);
  }

  if (connectionIssueListeners.size === 0) {
    return;
  }

  // Only surface connection-related messages
  const lower = message.toLowerCase();
  const isConnectionIssue =
    CONNECTION_ISSUE_PATTERNS.some((p) => lower.includes(p)) ||
    (level === 1 && target.includes("network"));

  if (isConnectionIssue) {
    for (const cb of connectionIssueListeners) {
      cb(message);
    }
  }
}

// ── Shared smoldot instance ──────────────────────────────────

let smoldotInstance: SmoldotClient | null = null;
let relayChainPromise: Promise<SmoldotChain> | null = null;

/**
 * Create smoldot using `start()` — runs on the current thread.
 *
 * Used in SharedWorker context where the `Worker` constructor is unavailable.
 * Smoldot networking (WebSocket) is async; occasional CPU bursts for block
 * verification (~2-10ms per block) are acceptable on the SharedWorker thread.
 */
export function getSmoldotDirect(): SmoldotClient {
  if (smoldotInstance !== null) {
    return smoldotInstance;
  }
  log.warn("[dot.li smoldot] Creating smoldot via start() (current thread)");
  smoldotInstance = startSmoldotDirect({
    maxLogLevel: 5,
    logCallback: smoldotLogCallback,
  });
  log.warn("[dot.li smoldot] Smoldot client ready (direct mode)");
  return smoldotInstance;
}

export function getSmoldot(): SmoldotClient {
  if (smoldotInstance !== null) {
    return smoldotInstance;
  }
  log.warn("[dot.li smoldot] Creating smoldot via startFromWorker()");
  smoldotInstance = startFromWorker(new SmWorker(), {
    maxLogLevel: 5,
    logCallback: smoldotLogCallback,
  });
  return smoldotInstance;
}

/**
 * Tear down every cached singleton bound to the shared smoldot instance.
 *
 * When smoldot itself is terminated (user switched chain backend, panic
 * broadcast, etc.) every chain promise we had cached is pointing at a
 * dead `SmoldotChain`. If any of them survive, the next call to e.g.
 * `getBulletinChain()` would return a promise that resolves to a chain
 * whose `sendJsonRpc` is a no-op — the user would see a silent hang.
 * Clear them all atomically so the next access re-creates against the
 * freshly booted smoldot.
 */
export function terminateSmoldot(): void {
  if (smoldotInstance === null) {
    return;
  }
  log.warn("[dot.li smoldot] Terminating smoldot instance");
  try {
    void smoldotInstance.terminate();
    // eslint-disable-next-line no-restricted-syntax -- best-effort teardown: smoldot may already be dead (panic or prior terminate); surfacing the error would block the subsequent promise cleanup which is the important step here.
  } catch {
    /* already destroyed or crashed — safe to ignore */
  }
  smoldotInstance = null;
  relayChainPromise = null;
  resolverAssetHubPromise = null;
  assetHubProvider = null;
  dappAssetHubPromise = null;
  bulletinChainPromise = null;
  peopleChainPromise = null;
  customRelayChainPromise = null;
}

export function getRelayChain(): Promise<SmoldotChain> {
  // Clear the cached promise on rejection so the next call retries
  // against a fresh smoldot / chain-spec fetch instead of handing the
  // same dead rejection to every caller forever.
  relayChainPromise ??= getPaseoChainSpec()
    .then((chainSpec) => {
      log.warn("[dot.li smoldot] Adding relay chain...");
      m.breadcrumb("Adding relay chain");
      return getSmoldot().addChain({ chainSpec });
    })
    .catch((error: unknown) => {
      relayChainPromise = null;
      m.count(S.BOOTNODE_ERROR, { chain: "relay" });
      throw error;
    });
  return relayChainPromise;
}

// ── Provider factories ──────────────────────────────────────

// ── Bulletin Paseo chain (for preimage operations) ───────────
// Long-lived singleton — no mutex conflict with Asset Hub.

let bulletinChainPromise: Promise<SmoldotChain> | null = null;

/**
 * Get or create the Bulletin Paseo parachain singleton.
 * Used for preimage submission via TransactionStorage.
 *
 * Rejections clear the cached promise so a subsequent call re-creates
 * the chain instead of permanently caching the failure.
 */
export function getBulletinChain(): Promise<SmoldotChain> {
  bulletinChainPromise ??= Promise.all([
    getRelayChain(),
    getBulletinPaseoChainSpec(),
  ])
    .then(([relayChain, chainSpec]) =>
      getSmoldot().addChain({
        chainSpec,
        potentialRelayChains: [relayChain],
      }),
    )
    .catch((error: unknown) => {
      bulletinChainPromise = null;
      m.count(S.BOOTNODE_ERROR, { chain: "bulletin" });
      throw error;
    });
  return bulletinChainPromise;
}

// ── Shared Asset Hub Paseo chain (for dApp connections) ──────
// Created lazily after the resolver releases the mutex.
/**
 * Wrap a chain so `.remove()` is a no-op.
 * Used for shared singletons (e.g. bulletin chain) where a polkadot-api
 * client must not tear down the underlying chain on disconnect.
 */
export function makeNonRemovingChain(chain: SmoldotChain): SmoldotChain {
  return {
    sendJsonRpc: chain.sendJsonRpc.bind(chain),
    nextJsonRpcResponse: chain.nextJsonRpcResponse.bind(chain),
    jsonRpcResponses: chain.jsonRpcResponses,
    remove: () => {
      /* intentional no-op: chain is a shared singleton */
    },
  };
}

// ── People Chain (for statement store / auth) ────────────────
// Long-lived singleton used by the auth module for statement store
// operations via smoldot. The active chain spec (westend-local,
// next-people-paseo, …) is hard-coded in `@dotli/config/config`
// as `SS_PEOPLE_CHAIN` — change it there and deploy as a single commit.

import { SS_RELAY_CHAIN } from "@dotli/config/config";

let customRelayChainPromise: Promise<SmoldotChain> | null = null;
let peopleChainPromise: Promise<SmoldotChain> | null = null;

/**
 * Get or create the People Chain parachain singleton.
 * Enables the statement store protocol for P2P statement distribution.
 *
 * Both the custom-relay and people-chain promises clear themselves on
 * rejection so the failure isn't permanently cached across a live
 * session — the next access rebuilds against a fresh smoldot chain.
 */
export function getPeopleChain(): Promise<SmoldotChain> {
  if (peopleChainPromise !== null) {
    return peopleChainPromise;
  }

  const relayPromise =
    SS_RELAY_CHAIN !== undefined && SS_RELAY_CHAIN !== ""
      ? (customRelayChainPromise ??= getCustomRelayChainSpec()
          .then((spec) => getSmoldot().addChain({ chainSpec: spec }))
          .catch((error: unknown) => {
            customRelayChainPromise = null;
            m.count(S.BOOTNODE_ERROR, { chain: "custom-relay" });
            throw error;
          }))
      : getRelayChain();

  peopleChainPromise = Promise.all([relayPromise, getPeopleChainSpec()])
    .then(([relayChain, chainSpec]) =>
      getSmoldot().addChain({
        chainSpec,
        potentialRelayChains: [relayChain],
        statementStore: { maxSeenStatements: 65536 },
      }),
    )
    .catch((error: unknown) => {
      peopleChainPromise = null;
      m.count(S.BOOTNODE_ERROR, { chain: "people" });
      throw error;
    });
  return peopleChainPromise;
}

/**
 * Get a JsonRpcProvider backed by the People Chain smoldot singleton.
 * Used by the auth module as a drop-in replacement for the WS provider.
 */
export function getPeopleChainProvider(): JsonRpcProvider {
  return getSmProvider(() => getPeopleChain().then(makeNonRemovingChain));
}

// ── Dedicated provider factories ─────────────────────────────

let resolverAssetHubPromise: Promise<SmoldotChain> | null = null;
let assetHubProvider: JsonRpcProvider | null = null;

function createAssetHubChain(
  relay: Promise<SmoldotChain>,
): Promise<SmoldotChain> {
  const t0 = performance.now();
  return Promise.all([relay, getAssetHubPaseoChainSpec()])
    .then(([relayChain, chainSpec]) => {
      log.warn("[dot.li smoldot] Adding Asset Hub parachain...");
      m.breadcrumb("Adding Asset Hub parachain");
      return getSmoldot().addChain({
        chainSpec,
        potentialRelayChains: [relayChain],
      });
    })
    .then((chain) => {
      m.measure(S.SMOLDOT_ASSET_HUB, performance.now() - t0);
      m.distribution(S.SMOLDOT_ASSET_HUB, performance.now() - t0);
      return chain;
    })
    .catch((error: unknown) => {
      m.count(S.BOOTNODE_ERROR, { chain: "asset-hub" });
      throw error;
    });
}

function getResolverAssetHubChain(): Promise<SmoldotChain> {
  resolverAssetHubPromise ??= createAssetHubChain(getRelayChain()).catch(
    (error: unknown) => {
      resolverAssetHubPromise = null;
      throw error;
    },
  );
  return resolverAssetHubPromise;
}

export function getResolverAssetHubProvider(): JsonRpcProvider {
  assetHubProvider ??= getSmProvider(() => getResolverAssetHubChain());
  return assetHubProvider;
}

// ── dApp Asset Hub chain (fresh, no shared history) ─────────────
//
// After the resolver finishes dotNS resolution, its chain can be released.
// dApp connections then use a FRESH chain that has no "announced blocks"
// history, avoiding smoldot's per-connection block deduplication.

let dappAssetHubPromise: Promise<SmoldotChain> | null = null;

/**
 * Release the resolver's Asset Hub chain so a fresh chain can be created
 * for dApp connections. After calling this, the resolver's polkadot-api
 * client is no longer usable (CID is already cached).
 */
export function releaseResolverAssetHubChain(): void {
  if (resolverAssetHubPromise === null) {
    return;
  }
  log.warn("[dot.li smoldot] Releasing resolver Asset Hub chain");
  void resolverAssetHubPromise
    .then((chain) => {
      chain.remove();
      log.warn("[dot.li smoldot] Resolver Asset Hub chain removed");
    })
    .catch(() => {
      /* already dead or not yet created */
    });
  resolverAssetHubPromise = null;
  assetHubProvider = null;
}

/**
 * Get or create a fresh Asset Hub chain for dApp connections.
 *
 * This chain is separate from the resolver's chain and has no
 * "announced blocks" history — smoldot will send complete newBlock
 * events for all non-finalized blocks on new subscriptions.
 *
 * The returned chain wraps `remove()` to clear the cached promise,
 * so the next call creates a fresh chain. This is necessary because
 * `getSmProvider` calls `chain.remove()` on disconnect — without
 * cache invalidation, subsequent providers would reference a
 * destroyed chain.
 */
export function getDappAssetHubChain(): Promise<SmoldotChain> {
  dappAssetHubPromise ??= createAssetHubChain(getRelayChain())
    .then((chain) => ({
      sendJsonRpc: chain.sendJsonRpc.bind(chain),
      nextJsonRpcResponse: chain.nextJsonRpcResponse.bind(chain),
      jsonRpcResponses: chain.jsonRpcResponses,
      remove() {
        dappAssetHubPromise = null;
        chain.remove();
      },
    }))
    .catch((error: unknown) => {
      dappAssetHubPromise = null;
      throw error;
    });
  return dappAssetHubPromise;
}

/**
 * Return a provider backed by the dApp's fresh Asset Hub chain.
 * Used by `createChainProvider()` for remote dApp connections.
 */
export function getDappAssetHubProvider(): JsonRpcProvider {
  return getSmProvider(() => getDappAssetHubChain());
}
