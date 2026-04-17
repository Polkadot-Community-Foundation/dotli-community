// dot.li — Content fetching from Bulletin Chain via IPFS P2P
//
// Uses the same HeliaClient implementation as polkadot-bulletin-chain/console-ui.
// Connects to Bulletin Chain peers via bitswap over WebSocket.

import { TIMEOUTS } from "@dotli/config/config";
import { getActiveBulletinPeers } from "@dotli/config/endpoints";
import { dur } from "@dotli/shared/perf";
import { log } from "@dotli/shared/log";
import { serializeError } from "@dotli/shared/errors";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import { createHelia, type Helia } from "helia";
import { unixfs } from "@helia/unixfs";
import { CID } from "multiformats/cid";
import { multiaddr } from "@multiformats/multiaddr";
import { blake2b256 } from "@multiformats/blake2/blake2b";
import { sha256 } from "multiformats/hashes/sha2";
import { from as hasherFrom } from "multiformats/hashes/hasher";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes } from "@noble/hashes/utils.js";
export type StatusCallback = (status: string) => void;
import { isCarFile, parseIpfsResponse, type ArchiveFiles } from "./archive";
import { fetchFromIpfs, fetchCarFromIpfs } from "./ipfs";

const keccak256Hasher = hasherFrom({
  name: "keccak-256",
  code: 0x1b,
  encode: (input: Uint8Array) => keccak_256(input),
});

// ── HeliaClient (same as console-ui/src/lib/helia.ts) ────

export interface HeliaClientConfig {
  peerMultiaddrs: string[];
  onLog?: (
    level: "info" | "debug" | "error" | "success",
    message: string,
    data?: unknown,
  ) => void;
}

export interface ConnectionInfo {
  peerId: string;
  remoteAddr: string;
  direction: string;
}

export interface HeliaFetchResult {
  data: Uint8Array;
  isJSON: boolean;
  parsedJSON?: unknown;
}

/**
 * Per-peer dial outcome — returned from `HeliaClient.initialize()` so
 * the UI can surface "peer X failed" individually instead of only
 * seeing "could not connect to any peer" after the threshold check.
 */
export interface PeerDialOutcome {
  addr: string;
  ok: boolean;
  error?: string;
}

export class HeliaClient {
  private config: HeliaClientConfig;
  private helia?: Helia;
  private connectedPeers: ConnectionInfo[] = [];

  constructor(config: HeliaClientConfig) {
    this.config = config;
  }

  private log(
    level: "info" | "debug" | "error" | "success",
    message: string,
    data?: unknown,
  ): void {
    if (this.config.onLog) {
      this.config.onLog(level, message, data);
    } else {
      const prefix = {
        info: "INFO",
        debug: "DEBUG",
        error: "ERROR",
        success: "OK",
      }[level];
      // eslint-disable-next-line no-console
      console.log(`[${prefix}] ${message}`, data ?? "");
    }
  }

  async initialize(): Promise<{
    peerId: string;
    connections: ConnectionInfo[];
    dialOutcomes: PeerDialOutcome[];
  }> {
    this.log("info", "Initializing Helia P2P client...");

    // Extract peer IDs from provided multiaddrs for whitelist
    const allowedPeerIds = new Set<string>();
    for (const addr of this.config.peerMultiaddrs) {
      const match = /\/p2p\/([^/]+)/.exec(addr);
      if (match?.[1] !== undefined && match[1] !== "") {
        allowedPeerIds.add(match[1]);
      }
    }

    const peerIdList = [...allowedPeerIds].map((id) => id.slice(-8)).join(", ");
    this.log(
      "info",
      `Connection gater: ${String(allowedPeerIds.size)} whitelisted peer(s) [${peerIdList}]`,
    );

    // Create Helia node with blake2b256 hasher for Polkadot/Substrate CID compatibility
    this.helia = await createHelia({
      hashers: [blake2b256, sha256, keccak256Hasher],
      libp2p: {
        connectionGater: {
          denyDialMultiaddr: (maAddr) => {
            const addr = maAddr.toString();
            const match = /\/p2p\/([^/]+)/.exec(addr);
            if (
              match?.[1] !== undefined &&
              match[1] !== "" &&
              allowedPeerIds.has(match[1])
            ) {
              return Promise.resolve(false); // Allow whitelisted peers
            }
            return Promise.resolve(true); // Deny all others
          },
        },
      },
    });

    const peerId = this.helia.libp2p.peerId.toString();
    this.log("success", `Helia node created with peer ID: ${peerId}`);

    // Connect to all peers in parallel
    this.log(
      "info",
      `Connecting to ${String(this.config.peerMultiaddrs.length)} peer(s) in parallel...`,
    );

    const helia = this.helia;
    const dialOutcomes: PeerDialOutcome[] = await Promise.all(
      this.config.peerMultiaddrs.map(async (addr) => {
        try {
          const ma = multiaddr(addr);
          await helia.libp2p.dial(ma);
          this.log("success", `Connected to peer: ${addr.slice(-20)}`);
          return { addr, ok: true };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.log(
            "error",
            `Failed to connect to peer: ${addr.slice(-20)}`,
            error,
          );
          return { addr, ok: false, error: reason };
        }
      }),
    );

    // Get connection info
    const connections = this.helia.libp2p.getConnections();
    this.connectedPeers = connections.map((conn) => ({
      peerId: conn.remotePeer.toString(),
      remoteAddr: conn.remoteAddr.toString(),
      direction: conn.direction,
    }));

    const okCount = dialOutcomes.filter((o) => o.ok).length;
    this.log(
      "success",
      `Connected to ${String(this.connectedPeers.length)} peer(s) (${String(okCount)}/${String(dialOutcomes.length)} dials succeeded)`,
    );

    return { peerId, connections: this.connectedPeers, dialOutcomes };
  }

  async fetchData(cidOrString: string | CID): Promise<HeliaFetchResult> {
    if (!this.helia) {
      throw new Error("Helia not initialized");
    }

    let cid: CID;
    if (typeof cidOrString === "string") {
      try {
        cid = CID.parse(cidOrString);
      } catch (error) {
        throw new Error(`Invalid CID: ${serializeError(error)}`, {
          cause: error,
        });
      }
    } else {
      cid = cidOrString;
    }

    this.log("info", `Fetching CID: ${cid.toString()}`);
    this.log(
      "debug",
      `CID parsed: version=${String(cid.version)}, codec=0x${cid.code.toString(16)}`,
    );

    this.log("debug", "Requesting block from blockstore...");
    const blockData = this.helia.blockstore.get(cid);

    // Convert to Uint8Array
    let data: Uint8Array;
    if (blockData instanceof Uint8Array) {
      data = blockData;
    } else if (
      typeof blockData === "object" &&
      Symbol.asyncIterator in Object(blockData)
    ) {
      // Handle async iterable (streaming response)
      const chunks: Uint8Array[] = [];
      const timeoutMs = TIMEOUTS.P2P_FETCH;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Timeout after ${String(timeoutMs / 1000)}s`));
        }, timeoutMs);
      });

      const iterator = (blockData as AsyncIterable<Uint8Array>)[
        Symbol.asyncIterator
      ]();
      let done = false;
      while (!done) {
        const result = await Promise.race([iterator.next(), timeoutPromise]);
        if (result.done === true) {
          done = true;
        } else {
          chunks.push(result.value);
        }
      }

      if (chunks.length === 0) {
        throw new Error("No data received from peer");
      }

      data = concatBytes(...chunks);
    } else {
      throw new Error(`Unexpected block data type: ${typeof blockData}`);
    }

    this.log("success", `Fetched ${String(data.length)} bytes`);

    // Try to parse as JSON
    try {
      const text = new TextDecoder().decode(data);
      const parsed = JSON.parse(text) as unknown;
      return { data, isJSON: true, parsedJSON: parsed };
    } catch {
      return { data, isJSON: false };
    }
  }

  getHelia(): Helia | undefined {
    return this.helia;
  }

  getConnections(): ConnectionInfo[] {
    return this.connectedPeers;
  }

  isInitialized(): boolean {
    return !!this.helia;
  }

  async stop(): Promise<void> {
    if (this.helia) {
      await this.helia.stop();
      this.helia = undefined;
      this.connectedPeers = [];
      this.log("info", "Helia client stopped");
    }
  }
}

// ── dotli wrapper (backward-compatible API) ──────────────
//
// The Helia client is cached by the exact peer list it was built with.
// If the user changes their Bulletin peers (custom endpoints, profile
// switch) mid-session, a new client MUST be built — otherwise the next
// fetch would run against the old peer set, violating the determinism
// contract ("the user's chosen path is the only path").

let client: HeliaClient | null = null;
let clientPeerFingerprint: string | null = null;

function peerFingerprint(peers: readonly string[]): string {
  // Sorted join so the fingerprint is order-insensitive — peer array
  // ordering is not meaningful to the user.
  return [...peers].sort().join("|");
}

function getClient(): HeliaClient {
  const peers = getActiveBulletinPeers();
  const fingerprint = peerFingerprint(peers);
  if (client !== null && clientPeerFingerprint === fingerprint) {
    return client;
  }
  if (client !== null && clientPeerFingerprint !== fingerprint) {
    // Peer list changed under us — tear down the old client before
    // building a new one against the user's current selection.
    log.warn(
      "[dot.li fetch] Bulletin peer set changed; rebuilding Helia client",
    );
    const prev = client;
    client = null;
    clientPeerFingerprint = null;
    void prev.stop().catch((err: unknown) => {
      log.warn("[dot.li fetch] Helia stop() failed during rebuild:", err);
    });
  }
  client = new HeliaClient({
    peerMultiaddrs: peers,
    onLog: (level, message, data) => {
      const fn =
        level === "error"
          ? log.error
          : level === "success"
            ? log.warn
            : level === "debug"
              ? log.debug
              : log.warn;
      fn(`[dot.li fetch] ${message}`, data ?? "");
    },
  });
  clientPeerFingerprint = fingerprint;
  return client;
}

/**
 * Initialize the Helia P2P client.
 *
 * Surfaces per-peer dial outcomes via the status callback so a UI
 * operator can see "peer X failed" individually. The N-1 failure case
 * (one peer up, three down) would otherwise look identical to the
 * all-peers-healthy case — a deterministic path needs visibility into
 * each peer, not just the aggregate.
 */
export async function ensureHelia(onStatus?: StatusCallback): Promise<Helia> {
  const c = getClient();
  if (!c.isInitialized()) {
    onStatus?.("Initializing P2P client...");
    const initStart = performance.now();
    const stopInit = m.timer(S.CONTENT_HELIA_INIT);
    const { connections, dialOutcomes } = await c.initialize();
    stopInit();
    log.warn(`[dot.li fetch] ensureHelia() done (${dur(initStart)})`);
    m.gauge("content.peer_connections", connections.length, "none");

    // Emit a per-peer count so dashboards see failures even when the
    // cluster is up in aggregate.
    for (const outcome of dialOutcomes) {
      m.count("content.peer_dial", {
        outcome: outcome.ok ? "ok" : "error",
      });
      if (!outcome.ok) {
        log.warn(
          `[dot.li fetch] peer dial failed: ${outcome.addr.slice(-32)} — ${outcome.error ?? "unknown"}`,
        );
      }
    }

    const okPeers = dialOutcomes.filter((o) => o.ok).length;
    const failedPeers = dialOutcomes.length - okPeers;
    if (failedPeers > 0) {
      onStatus?.(
        `Connected to ${String(okPeers)}/${String(dialOutcomes.length)} peer(s) — ${String(failedPeers)} failed`,
      );
    } else {
      onStatus?.(`Connected to ${String(connections.length)} peer(s)`);
    }
    if (connections.length === 0) {
      const detail = dialOutcomes
        .filter((o) => !o.ok)
        .map((o) => `${o.addr.slice(-32)}: ${o.error ?? "unknown"}`)
        .join("; ");
      throw new Error(
        `Could not connect to any Bulletin Chain peers${detail.length > 0 ? ` (${detail})` : ""}`,
      );
    }
  }
  const helia = c.getHelia();
  if (!helia) {
    throw new Error("Helia not initialized");
  }
  return helia;
}

// ── Content fetching ─────────────────────────────────────

export type FetchResult =
  | { type: "single"; content: Uint8Array }
  | { type: "archive"; files: ArchiveFiles };

/**
 * Fetch content via P2P (Helia/bitswap) with a timeout.
 */
async function fetchViaP2P(
  cidString: string,
  onStatus?: StatusCallback,
): Promise<FetchResult> {
  const stopP2p = m.timer(S.CONTENT_P2P);
  const helia = await ensureHelia(onStatus);
  const cid = CID.parse(cidString);

  // Abort signal for the entire P2P fetch
  const controller = new AbortController();
  const signal = controller.signal;
  const timer = setTimeout(() => {
    log.warn(
      `[dot.li fetch] P2P timeout after ${String(TIMEOUTS.P2P_FETCH / 1000)}s, aborting...`,
    );
    m.count(S.CONTENT_P2P, { outcome: "timeout" });
    controller.abort();
  }, TIMEOUTS.P2P_FETCH);

  onStatus?.("Fetching content via P2P...");
  const p2pStart = performance.now();
  log.warn(
    `[dot.li fetch] CID: codec=0x${cid.code.toString(16)}, hash=0x${cid.multihash.code.toString(16)}, version=${String(cid.version)}`,
  );

  try {
    if (cid.code === 0x70) {
      // dag-pb (UnixFS) — the CID is either a file or a directory. Ask
      // UnixFS up-front via `fs.stat(cid)` so the branch is structural
      // rather than error-message-driven. The old approach (attempt
      // `fs.cat()` and branch on `"not a file"` in the error message)
      // was brittle: any future version of the unixfs package that
      // localized or rewrote that message would silently turn directory
      // CIDs into fatal errors.
      log.warn(`[dot.li fetch] P2P: fetching dag-pb (UnixFS) CID...`);
      const fs = unixfs(helia);

      log.warn(`[dot.li fetch] P2P: step=stat (determine file vs dir)`);
      const stat = await fs.stat(cid, { signal });
      const unixfsType: string | undefined = (stat as { type?: string }).type;
      const isDirectory =
        unixfsType === "directory" || unixfsType === "hamt-sharded-directory";

      if (!isDirectory) {
        log.warn(`[dot.li fetch] P2P: step=cat (type=${unixfsType ?? "file"})`);
        const chunks: Uint8Array[] = [];
        for await (const chunk of fs.cat(cid, { signal })) {
          chunks.push(chunk);
          log.debug(
            `[dot.li fetch] P2P: received chunk ${String(chunks.length)} (${String(chunk.length)} bytes)`,
          );
        }
        const content = concatBytes(...chunks);
        log.warn(
          `[dot.li fetch] P2P: fetched file ${String(Math.round(content.length / 1024))} KB in ${dur(p2pStart)}`,
        );
        if (isCarFile(content)) {
          log.warn(`[dot.li fetch] P2P: content is a CAR file, parsing...`);
          const files = await parseIpfsResponse(content);
          return toFetchResult(files);
        }
        return { type: "single", content };
      }

      log.warn(`[dot.li fetch] P2P: step=walk (UnixFS type=${unixfsType})`);
      onStatus?.("Fetching directory via P2P...");
      const files: ArchiveFiles = {};
      const CONCURRENCY = 6;

      async function walkDir(dirCid: CID, prefix: string): Promise<void> {
        log.warn(`[dot.li fetch] P2P: listing directory ${prefix || "/"}...`);
        // `fs.ls()` already surfaces a typed `UnixFSEntry.type`, so
        // keep the type alongside the cid/path triple — no need to
        // string-match "not a file" on each cat() error. The walker
        // branches structurally, and real cat failures (timeouts,
        // missing blocks) propagate unchanged.
        const entries: {
          cid: CID;
          path: string;
          type: string | undefined;
        }[] = [];
        for await (const entry of fs.ls(dirCid, { signal })) {
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          const type = (entry as { type?: string }).type;
          entries.push({ cid: entry.cid, path, type });
          log.debug(
            `[dot.li fetch] P2P: found entry: ${path} (type=${type ?? "?"})`,
          );
        }
        log.warn(
          `[dot.li fetch] P2P: listed ${String(entries.length)} entries in ${prefix || "/"}`,
        );

        let i = 0;
        async function next(): Promise<void> {
          while (i < entries.length) {
            const entry = entries[i++];
            const isSubdir =
              entry.type === "directory" ||
              entry.type === "hamt-sharded-directory";
            if (isSubdir) {
              await walkDir(entry.cid, entry.path);
              continue;
            }
            log.debug(`[dot.li fetch] P2P: fetching file ${entry.path}...`);
            const chunks: Uint8Array[] = [];
            for await (const chunk of fs.cat(entry.cid, { signal })) {
              chunks.push(chunk);
            }
            files[entry.path] = concatBytes(...chunks);
            log.debug(
              `[dot.li fetch] P2P: fetched ${entry.path} (${String(files[entry.path].length)} bytes)`,
            );
          }
        }
        await Promise.all(Array.from({ length: CONCURRENCY }, () => next()));
      }

      await walkDir(cid, "");
      log.warn(
        `[dot.li fetch] P2P: fetched directory (${String(Object.keys(files).length)} files) in ${dur(p2pStart)}`,
      );
      return toFetchResult(files);
    }

    // Raw block or other codec — use HeliaClient.fetchData
    log.warn(
      `[dot.li fetch] P2P: fetching raw block (codec 0x${cid.code.toString(16)})...`,
    );
    const c = getClient();
    const fetchResult = await c.fetchData(cid);
    log.warn(
      `[dot.li fetch] P2P: fetched ${String(fetchResult.data.length)} bytes in ${dur(p2pStart)}`,
    );
    return { type: "single", content: fetchResult.data };
  } finally {
    stopP2p();
    clearTimeout(timer);
  }
}

/**
 * Fetch content via IPFS gateway.
 *
 * No silent CAR→plain fallback. The CID codec deterministically decides
 * which transport is correct:
 *   - DAG-PB (0x70): UnixFS directory or chunked file → request CAR
 *   - RAW    (0x55): single raw block → plain HTTP GET
 * Any other codec is a hard failure — we don't guess. Any transport
 * failure surfaces with the original cause.
 */
const CODEC_DAG_PB = 0x70;
const CODEC_RAW = 0x55;

async function fetchViaGateway(
  cidString: string,
  onStatus?: StatusCallback,
): Promise<FetchResult> {
  const stopGw = m.timer(S.CONTENT_GATEWAY);
  try {
    const cid = CID.parse(cidString);
    if (cid.code === CODEC_DAG_PB) {
      onStatus?.("Fetching archive from IPFS gateway...");
      log.warn(`[dot.li fetch] Gateway: requesting CAR (codec dag-pb)...`);
      const gatewayStart = performance.now();
      const carBuffer = await fetchCarFromIpfs(cidString);
      log.warn(
        `[dot.li fetch] Gateway CAR: fetched ${String(Math.round(carBuffer.length / 1024))} KB in ${dur(gatewayStart)}`,
      );
      onStatus?.("Parsing content...");
      const files = await parseIpfsResponse(carBuffer);
      return toFetchResult(files);
    }
    if (cid.code === CODEC_RAW) {
      onStatus?.("Fetching content via IPFS gateway...");
      log.warn(`[dot.li fetch] Gateway: plain GET (codec raw)...`);
      const gatewayStart = performance.now();
      const { data } = await fetchFromIpfs(cidString);
      log.warn(
        `[dot.li fetch] Gateway: fetched ${String(Math.round(data.length / 1024))} KB in ${dur(gatewayStart)}`,
      );
      return { type: "single", content: data };
    }
    throw new Error(
      `Unsupported CID codec for gateway fetch: 0x${cid.code.toString(16)} (cid=${cidString})`,
    );
  } finally {
    stopGw();
  }
}

/**
 * Fetch content by CID using the specified mode.
 *
 * - `"p2p"` (default): Helia/bitswap from Bulletin Chain peers
 * - `"gateway"`: HTTP fetch from IPFS gateway
 *
 * No fallback between modes — if the chosen path fails, it fails.
 */
export async function fetchArchive(
  cidString: string,
  onStatus?: StatusCallback,
  options?: { useGateway?: boolean },
): Promise<FetchResult> {
  performance.mark("dotli:fetch:start");
  const stopFetch = m.timer(S.CONTENT_FETCH);
  const method = options?.useGateway === true ? "gateway" : "p2p";
  m.tag("content_method", method);

  try {
    const result =
      method === "gateway"
        ? await fetchViaGateway(cidString, onStatus)
        : await fetchViaP2P(cidString, onStatus);
    performance.mark("dotli:fetch:end");
    log.warn(`[dot.li fetch] Content fetched via ${method}`);
    measureContentSize(result);
    stopFetch();
    return result;
  } catch (err) {
    performance.mark("dotli:fetch:end");
    stopFetch();
    if (err instanceof Error) {
      log.error(`[dot.li fetch] ${method} failed: ${err.message}`);
    }
    throw err;
  }
}

function measureContentSize(result: FetchResult): void {
  if (result.type === "single") {
    m.distribution(S.CONTENT_SIZE, result.content.length, "byte");
  } else {
    const totalSize = Object.values(result.files).reduce(
      (sum, buf) => sum + buf.length,
      0,
    );
    m.distribution(S.CONTENT_SIZE, totalSize, "byte");
  }
}

function toFetchResult(files: ArchiveFiles): FetchResult {
  const keys = Object.keys(files);
  if (keys.length === 1 && keys[0] === "index.html") {
    return { type: "single", content: files["index.html"] };
  }
  log.warn(
    `[dot.li] Loaded archive with ${String(keys.length)} file(s):`,
    keys,
  );
  return { type: "archive", files };
}

/**
 * Cleanup Helia instance.
 */
export async function destroyHelia(): Promise<void> {
  if (client) {
    await client.stop();
    client = null;
    clientPeerFingerprint = null;
  }
}
