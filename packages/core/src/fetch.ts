// dot.li — Content fetching from Bulletin Chain
//
// Helia P2P (in-browser libp2p node dials Bulletin peers via bitswap)
//
// Pattern from: polkadot-bulletin-chain-main/console-ui/src/lib/helia.ts

import { TIMEOUTS } from "./config";
import { dur } from "./perf";
import { log } from "./log";
import { createHelia, type Helia } from "helia";
import { bitswap } from "@helia/block-brokers";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { unixfs } from "@helia/unixfs";
import { CID } from "multiformats/cid";
import { multiaddr } from "@multiformats/multiaddr";
import { blake2b256 } from "@multiformats/blake2/blake2b";
import { sha256 } from "multiformats/hashes/sha2";
import { from as hasherFrom } from "multiformats/hashes/hasher";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { BULLETIN_PEERS } from "./config";
import type { StatusCallback } from "./resolve";
import { isCarFile, parseIpfsResponse, type ArchiveFiles } from "./archive";

const keccak256Hasher = hasherFrom({
  name: "keccak-256",
  code: 0x1b,
  encode: (input: Uint8Array) => keccak_256(input),
});

let heliaInstance: Helia | null = null;

/**
 * Initialize Helia P2P node with Bulletin Chain peers.
 * Whitelists only known Bulletin peers (same pattern as console-ui).
 */
export async function ensureHelia(onStatus?: StatusCallback): Promise<Helia> {
  if (heliaInstance) {
    return heliaInstance;
  }

  onStatus?.("Initializing P2P client...");
  const heliaStart = performance.now();

  // Extract peer IDs for whitelist
  const allowedPeerIds = new Set<string>();
  for (const addr of BULLETIN_PEERS) {
    const match = /\/p2p\/([^/]+)/.exec(addr);
    if (match?.[1] !== undefined && match[1] !== "") {
      allowedPeerIds.add(match[1]);
    }
  }

  const createStart = performance.now();
  heliaInstance = await createHelia({
    hashers: [blake2b256, sha256, keccak256Hasher],
    blockBrokers: [bitswap()],
    routers: [],
    libp2p: {
      // Minimal libp2p config — we only dial known Bulletin peers via WebSocket.
      // Strips DHT, delegated routing, autoNAT, circuit relay, webRTC, bootstrap.
      addresses: { listen: [] },
      transports: [webSockets()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: [],
      services: {
        identify: identify(),
      },
      connectionGater: {
        denyDialMultiaddr: (maAddr) => {
          const addr = maAddr.toString();
          const match = /\/p2p\/([^/]+)/.exec(addr);
          if (
            match?.[1] !== undefined &&
            match[1] !== "" &&
            allowedPeerIds.has(match[1])
          ) {
            return false;
          }
          return true;
        },
      },
    },
  });
  log.warn(`[dot.li fetch] createHelia() done (${dur(createStart)})`);

  // Dial all peers in parallel and wait for all to settle before fetching.
  // This maximizes bitswap availability — more connected peers means a higher
  // chance that at least one has the requested block.
  onStatus?.("Connecting to Bulletin Chain peers...");
  const dialStart = performance.now();
  const helia = heliaInstance;
  const dialResults = await Promise.allSettled(
    BULLETIN_PEERS.map(async (addr) => {
      const peerStart = performance.now();
      try {
        await helia.libp2p.dial(multiaddr(addr));
        log.warn(
          `[dot.li fetch] Peer dialed (${dur(peerStart)}): ${addr.slice(-20)}`,
        );
      } catch (err) {
        log.warn(
          `[dot.li fetch] Peer failed (${dur(peerStart)}): ${addr.slice(-20)}`,
        );
        throw err;
      }
    }),
  );

  const connected = dialResults.filter((r) => r.status === "fulfilled").length;
  const failed = dialResults.filter((r) => r.status === "rejected").length;
  if (connected === 0) {
    throw new Error("Could not connect to any Bulletin Chain peers");
  }

  log.warn(
    `[dot.li fetch] All peers settled (${dur(dialStart)}): ${String(connected)} connected, ${String(failed)} failed`,
  );
  onStatus?.(`Connected to ${String(connected)} Bulletin peer(s)`);

  log.warn(`[dot.li fetch] ensureHelia() total: ${dur(heliaStart)}`);
  return heliaInstance;
}

/**
 * Concatenate chunks from a UnixFS cat stream into a single Uint8Array.
 */
async function collectCat(
  fs: ReturnType<typeof unixfs>,
  cid: CID,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of fs.cat(cid, { signal })) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Fetch content via Helia P2P from Bulletin Chain.
 */
async function fetchViaP2P(
  cidString: string,
  onStatus?: StatusCallback,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const helia = await ensureHelia(onStatus);
  const cid = CID.parse(cidString);

  onStatus?.("Fetching content via P2P...");
  const p2pStart = performance.now();
  log.warn(
    `[dot.li fetch] CID: codec=0x${cid.code.toString(16)}, hash=0x${cid.multihash.code.toString(16)}, version=${String(cid.version)}`,
  );

  // For dag-pb (UnixFS) content — could be a file or directory
  if (cid.code === 0x70) {
    log.warn(`[dot.li fetch] P2P: fetching dag-pb (UnixFS) CID...`);
    const fs = unixfs(helia);

    // Try as file first
    try {
      const content = await collectCat(fs, cid, signal);
      log.warn(
        `[dot.li fetch] P2P: fetched file ${String(Math.round(content.length / 1024))} KB in ${dur(p2pStart)}`,
      );
      // Content may be a CAR archive (e.g. deployed via web-hosting tooling)
      if (isCarFile(content)) {
        log.warn(`[dot.li fetch] P2P: content is a CAR file, parsing...`);
        const files = await parseIpfsResponse(content);
        return toFetchResult(files);
      }
      return { type: "single", content };
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("not a file")) {
        throw err;
      }
    }

    // It's a directory — walk it recursively with ls + cat
    log.warn(`[dot.li fetch] P2P: CID is a directory, walking entries...`);
    onStatus?.("Fetching directory via P2P...");
    const files: ArchiveFiles = {};

    // Collect all entries first, then fetch in parallel with concurrency limit
    const CONCURRENCY = 6;
    interface DirEntry {
      cid: CID;
      path: string;
    }

    async function collectEntries(
      dirCid: CID,
      prefix: string,
    ): Promise<DirEntry[]> {
      const entries: DirEntry[] = [];
      for await (const entry of fs.ls(dirCid, { signal })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        entries.push({ cid: entry.cid, path });
      }
      return entries;
    }

    async function walkDir(dirCid: CID, prefix: string): Promise<void> {
      const entries = await collectEntries(dirCid, prefix);
      let i = 0;
      async function next(): Promise<void> {
        while (i < entries.length) {
          const entry = entries[i++];
          try {
            files[entry.path] = await collectCat(fs, entry.cid, signal);
          } catch (catErr) {
            if (
              catErr instanceof Error &&
              catErr.message.includes("not a file")
            ) {
              await walkDir(entry.cid, entry.path);
            }
          }
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

  // For raw blocks (codec 0x55), consume the async generator from blockstore
  log.warn(
    `[dot.li fetch] P2P: fetching raw block (codec 0x${cid.code.toString(16)})...`,
  );
  const chunks: Uint8Array[] = [];
  for await (const chunk of helia.blockstore.get(cid, { signal })) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const content = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.length;
  }
  log.warn(
    `[dot.li fetch] P2P: fetched raw block ${String(Math.round(content.length / 1024))} KB in ${dur(p2pStart)}`,
  );
  return { type: "single", content };
}

// ── Multi-file archive support ─────────────────────────────

export type FetchResult =
  | { type: "single"; content: Uint8Array }
  | { type: "archive"; files: ArchiveFiles };

/**
 * Log a fetch error with AggregateError unwrapping for diagnostics.
 */
function logFetchError(err: unknown): void {
  if (err instanceof AggregateError && Array.isArray(err.errors)) {
    const reasons = err.errors
      .map((e) => (e instanceof Error ? e.message : String(e)))
      .join("; ");
    log.error(
      `[dot.li fetch] Block retrieval failed (${String(err.errors.length)} broker error(s)): ${reasons}`,
    );
  } else if (err instanceof Error) {
    log.error(`[dot.li fetch] Fetch failed: ${err.message}`);
  }
}

/**
 * Reconnect to Bulletin Chain peers by closing existing connections
 * and re-dialing all peers in parallel. Used between retry attempts
 * to reset bitswap state and establish fresh connections.
 */
async function reconnectPeers(): Promise<number> {
  if (heliaInstance === null) {
    return 0;
  }
  const helia = heliaInstance;

  // Close existing connections
  const existing = helia.libp2p.getConnections();
  log.warn(
    `[dot.li fetch] Reconnecting: closing ${String(existing.length)} existing connection(s)...`,
  );
  await Promise.allSettled(
    existing.map((conn) => helia.libp2p.hangUp(conn.remotePeer)),
  );

  // Re-dial all peers in parallel
  const dialResults = await Promise.allSettled(
    BULLETIN_PEERS.map(async (addr) => {
      await helia.libp2p.dial(multiaddr(addr));
    }),
  );

  const connected = dialResults.filter((r) => r.status === "fulfilled").length;
  log.warn(
    `[dot.li fetch] Reconnected: ${String(connected)}/${String(BULLETIN_PEERS.length)} peers`,
  );
  return connected;
}

/**
 * Fetch content by CID via P2P with retry and peer reconnection.
 *
 * On failure, closes existing peer connections, re-dials all Bulletin peers,
 * and retries the fetch. This resets bitswap state and gives peers a fresh
 * chance to respond. Retries up to P2P_MAX_RETRIES times with P2P_RETRY_DELAY
 * between attempts.
 */
export async function fetchArchive(
  cidString: string,
  onStatus?: StatusCallback,
): Promise<FetchResult> {
  performance.mark("dotli:fetch:p2p:start");

  let lastError: unknown;

  for (let attempt = 0; attempt <= TIMEOUTS.P2P_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      log.warn(
        `[dot.li fetch] Retry ${String(attempt)}/${String(TIMEOUTS.P2P_MAX_RETRIES)}: waiting ${String(TIMEOUTS.P2P_RETRY_DELAY / 1000)}s before reconnecting...`,
      );
      onStatus?.(
        `Reconnecting to peers...\nRetry attempt ${String(attempt)} of ${String(TIMEOUTS.P2P_MAX_RETRIES)}`,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, TIMEOUTS.P2P_RETRY_DELAY),
      );

      const connected = await reconnectPeers();
      if (connected === 0) {
        log.error("[dot.li fetch] Retry aborted: no peers reconnected");
        onStatus?.("Retry failed\nCould not reconnect to any peers");
        break;
      }
      onStatus?.(
        `Fetching content...\nRetry attempt ${String(attempt)} of ${String(TIMEOUTS.P2P_MAX_RETRIES)}`,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, TIMEOUTS.P2P_FETCH);

    // Wrap onStatus to show retry info on a second line
    const retryLabel = `Retry attempt ${String(attempt)} of ${String(TIMEOUTS.P2P_MAX_RETRIES)}`;
    const statusCb: StatusCallback | undefined =
      attempt > 0 ? (msg) => onStatus?.(`${msg}\n${retryLabel}`) : onStatus;

    try {
      const result = await fetchViaP2P(cidString, statusCb, controller.signal);
      clearTimeout(timer);
      if (attempt > 0) {
        log.warn(`[dot.li fetch] Succeeded on retry ${String(attempt)}`);
      }
      performance.mark("dotli:fetch:p2p:end");
      return result;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      logFetchError(err);

      if (attempt < TIMEOUTS.P2P_MAX_RETRIES) {
        log.warn(
          `[dot.li fetch] Attempt ${String(attempt + 1)} failed, will retry...`,
        );
      }
    }
  }

  performance.mark("dotli:fetch:p2p:end");
  throw lastError;
}

/**
 * Convert a parsed file map to a FetchResult.
 * If the archive only contains index.html, treat it as a single file.
 */
function toFetchResult(files: ArchiveFiles): FetchResult {
  const keys = Object.keys(files);
  if (keys.length === 1 && keys[0] === "index.html") {
    return { type: "single", content: files["index.html"] };
  }
  const fileCount = keys.length;
  log.warn(`[dot.li] Loaded archive with ${String(fileCount)} file(s):`, keys);
  return { type: "archive", files };
}

/**
 * Cleanup Helia instance.
 */
export async function destroyHelia(): Promise<void> {
  if (heliaInstance) {
    await heliaInstance.stop();
    heliaInstance = null;
  }
}
