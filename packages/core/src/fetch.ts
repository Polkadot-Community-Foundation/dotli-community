// dot.li — Content fetching from Bulletin Chain via IPFS P2P
//
// Uses the same HeliaClient implementation as polkadot-bulletin-chain/console-ui.
// Connects to Bulletin Chain peers via bitswap over WebSocket.

import { TIMEOUTS, BULLETIN_PEERS } from "./config";
import { dur } from "./perf";
import { log } from "./log";
import { createHelia, type Helia } from "helia";
import { unixfs } from "@helia/unixfs";
import { CID } from "multiformats/cid";
import { multiaddr } from "@multiformats/multiaddr";
import { blake2b256 } from "@multiformats/blake2/blake2b";
import { sha256 } from "multiformats/hashes/sha2";
import { from as hasherFrom } from "multiformats/hashes/hasher";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { StatusCallback } from "./resolve";
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
  }> {
    this.log("info", "Initializing Helia P2P client...");

    // Extract peer IDs from provided multiaddrs for whitelist
    const allowedPeerIds = new Set<string>();
    for (const addr of this.config.peerMultiaddrs) {
      const match = /\/p2p\/([^/]+)/.exec(addr);
      if (match?.[1]) {
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
          denyDialMultiaddr: async (maAddr) => {
            const addr = maAddr.toString();
            const match = /\/p2p\/([^/]+)/.exec(addr);
            if (match?.[1] && allowedPeerIds.has(match[1])) {
              return false; // Allow whitelisted peers
            }
            return true; // Deny all others
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
    await Promise.allSettled(
      this.config.peerMultiaddrs.map(async (addr) => {
        try {
          const ma = multiaddr(addr);
          await helia.libp2p.dial(ma);
          this.log("success", `Connected to peer: ${addr.slice(-20)}`);
        } catch (error) {
          this.log(
            "error",
            `Failed to connect to peer: ${addr.slice(-20)}`,
            error,
          );
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

    this.log(
      "success",
      `Connected to ${String(this.connectedPeers.length)} peer(s)`,
    );

    return { peerId, connections: this.connectedPeers };
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
        throw new Error(
          `Invalid CID: ${error instanceof Error ? error.message : String(error)}`,
        );
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
    const blockData = await this.helia.blockstore.get(cid);

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
        setTimeout(
          () => reject(new Error(`Timeout after ${String(timeoutMs / 1000)}s`)),
          timeoutMs,
        );
      });

      const iterator = (blockData as AsyncIterable<Uint8Array>)[
        Symbol.asyncIterator
      ]();
      let done = false;
      while (!done) {
        const result = await Promise.race([iterator.next(), timeoutPromise]);
        if (result.done) {
          done = true;
        } else {
          chunks.push(result.value);
        }
      }

      if (chunks.length === 0) {
        throw new Error("No data received from peer");
      }

      const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
      data = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
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

let client: HeliaClient | null = null;

function getClient(): HeliaClient {
  if (client === null) {
    client = new HeliaClient({
      peerMultiaddrs: BULLETIN_PEERS,
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
  }
  return client;
}

/**
 * Initialize the Helia P2P client.
 */
export async function ensureHelia(onStatus?: StatusCallback): Promise<Helia> {
  const c = getClient();
  if (!c.isInitialized()) {
    onStatus?.("Initializing P2P client...");
    const initStart = performance.now();
    const { connections } = await c.initialize();
    log.warn(`[dot.li fetch] ensureHelia() done (${dur(initStart)})`);
    onStatus?.(`Connected to ${String(connections.length)} peer(s)`);
    if (connections.length === 0) {
      throw new Error("Could not connect to any Bulletin Chain peers");
    }
  }
  const helia = c.getHelia();
  if (!helia) {
    throw new Error("Helia not initialized");
  }
  return helia;
}

// ── Content fetching ─────────────────────────────────────

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

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
  const helia = await ensureHelia(onStatus);
  const cid = CID.parse(cidString);

  // Abort signal for the entire P2P fetch
  const controller = new AbortController();
  const signal = controller.signal;
  const timer = setTimeout(() => {
    log.warn(
      `[dot.li fetch] P2P timeout after ${String(TIMEOUTS.P2P_FETCH / 1000)}s, aborting...`,
    );
    controller.abort();
  }, TIMEOUTS.P2P_FETCH);

  onStatus?.("Fetching content via P2P...");
  const p2pStart = performance.now();
  log.warn(
    `[dot.li fetch] CID: codec=0x${cid.code.toString(16)}, hash=0x${cid.multihash.code.toString(16)}, version=${String(cid.version)}`,
  );

  try {
    if (cid.code === 0x70) {
      // dag-pb (UnixFS) — file or directory
      log.warn(`[dot.li fetch] P2P: fetching dag-pb (UnixFS) CID...`);
      const fs = unixfs(helia);

      // Try as file first
      try {
        log.warn(`[dot.li fetch] P2P: trying fs.cat()...`);
        const chunks: Uint8Array[] = [];
        for await (const chunk of fs.cat(cid, { signal })) {
          chunks.push(chunk);
          log.debug(
            `[dot.li fetch] P2P: received chunk ${String(chunks.length)} (${String(chunk.length)} bytes)`,
          );
        }
        const content = concatChunks(chunks);
        log.warn(
          `[dot.li fetch] P2P: fetched file ${String(Math.round(content.length / 1024))} KB in ${dur(p2pStart)}`,
        );
        if (isCarFile(content)) {
          log.warn(`[dot.li fetch] P2P: content is a CAR file, parsing...`);
          const files = await parseIpfsResponse(content);
          return toFetchResult(files);
        }
        return { type: "single", content };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[dot.li fetch] P2P: fs.cat() failed: ${msg}`);
        if (!(err instanceof Error) || !err.message.includes("not a file")) {
          throw err;
        }
      }

      // It's a directory — walk it recursively
      log.warn(`[dot.li fetch] P2P: CID is a directory, walking entries...`);
      onStatus?.("Fetching directory via P2P...");
      const files: ArchiveFiles = {};
      const CONCURRENCY = 6;

      async function walkDir(dirCid: CID, prefix: string): Promise<void> {
        log.warn(`[dot.li fetch] P2P: listing directory ${prefix || "/"}...`);
        const entries: { cid: CID; path: string }[] = [];
        for await (const entry of fs.ls(dirCid, { signal })) {
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          entries.push({ cid: entry.cid, path });
          log.debug(`[dot.li fetch] P2P: found entry: ${path}`);
        }
        log.warn(
          `[dot.li fetch] P2P: listed ${String(entries.length)} entries in ${prefix || "/"}`,
        );

        let i = 0;
        async function next(): Promise<void> {
          while (i < entries.length) {
            const entry = entries[i++];
            try {
              log.debug(`[dot.li fetch] P2P: fetching file ${entry.path}...`);
              const chunks: Uint8Array[] = [];
              for await (const chunk of fs.cat(entry.cid, { signal })) {
                chunks.push(chunk);
              }
              files[entry.path] = concatChunks(chunks);
              log.debug(
                `[dot.li fetch] P2P: fetched ${entry.path} (${String(files[entry.path].length)} bytes)`,
              );
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
    clearTimeout(timer);
  }
}

/**
 * Fetch content via IPFS gateway (HTTP fallback).
 *
 * Strategy:
 * 1. Try ?format=car (returns directory tree as CAR archive)
 * 2. If CAR fails, try plain gateway fetch (single file)
 */
async function fetchViaGateway(
  cidString: string,
  onStatus?: StatusCallback,
): Promise<FetchResult> {
  // Try CAR format first (handles directories)
  try {
    onStatus?.("Fetching archive from IPFS gateway...");
    log.warn(`[dot.li fetch] Gateway: trying CAR format...`);
    const gatewayStart = performance.now();
    const carBuffer = await fetchCarFromIpfs(cidString);
    log.warn(
      `[dot.li fetch] Gateway CAR: fetched ${String(Math.round(carBuffer.length / 1024))} KB in ${dur(gatewayStart)}`,
    );
    onStatus?.("Parsing content...");
    const files = await parseIpfsResponse(carBuffer);
    return toFetchResult(files);
  } catch (carErr) {
    const carMsg = carErr instanceof Error ? carErr.message : String(carErr);
    log.warn(`[dot.li fetch] Gateway CAR failed: ${carMsg}`);
  }

  // Plain gateway fetch (single file)
  onStatus?.("Fetching content via IPFS gateway...");
  log.warn(`[dot.li fetch] Gateway: trying plain fetch...`);
  const gatewayStart = performance.now();
  const { data } = await fetchFromIpfs(cidString);
  log.warn(
    `[dot.li fetch] Gateway: fetched ${String(Math.round(data.length / 1024))} KB in ${dur(gatewayStart)}`,
  );
  return { type: "single", content: data };
}

/**
 * Fetch content by CID.
 * Tries P2P first (Helia/bitswap), falls back to IPFS gateway on failure.
 */
export async function fetchArchive(
  cidString: string,
  onStatus?: StatusCallback,
): Promise<FetchResult> {
  performance.mark("dotli:fetch:start");

  // Try P2P first
  try {
    const result = await fetchViaP2P(cidString, onStatus);
    performance.mark("dotli:fetch:end");
    return result;
  } catch (p2pErr) {
    if (p2pErr instanceof AggregateError && Array.isArray(p2pErr.errors)) {
      const reasons = p2pErr.errors
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join("; ");
      log.error(
        `[dot.li fetch] P2P failed (${String(p2pErr.errors.length)} broker error(s)): ${reasons}`,
      );
    } else if (p2pErr instanceof Error) {
      log.error(`[dot.li fetch] P2P failed: ${p2pErr.message}`);
    }
    log.warn(`[dot.li fetch] Falling back to IPFS gateway...`);
    onStatus?.("P2P unavailable, trying IPFS gateway...");
  }

  // Fallback to gateway
  try {
    const result = await fetchViaGateway(cidString, onStatus);
    performance.mark("dotli:fetch:end");
    return result;
  } catch (gwErr) {
    performance.mark("dotli:fetch:end");
    if (gwErr instanceof Error) {
      log.error(`[dot.li fetch] Gateway also failed: ${gwErr.message}`);
    }
    throw gwErr;
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
  }
}
