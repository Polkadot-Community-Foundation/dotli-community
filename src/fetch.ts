// dot.li — Content fetching from Bulletin Chain
//
// Primary: Helia P2P (in-browser libp2p node dials Bulletin peers via bitswap)
// Fallback: IPFS gateway HTTP fetch
//
// Pattern from: polkadot-bulletin-chain-main/console-ui/src/lib/helia.ts

function dur(start: number): string {
  return `${(performance.now() - start).toFixed(0)}ms`;
}

import { createHelia, type Helia } from "helia";
import { bitswap, trustlessGateway } from "@helia/block-brokers";
import { httpGatewayRouting } from "@helia/routers";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify, identifyPush } from "@libp2p/identify";
import { ping } from "@libp2p/ping";
import { webSockets } from "@libp2p/websockets";
import { unixfs } from "@helia/unixfs";
import { CID } from "multiformats/cid";
import { multiaddr } from "@multiformats/multiaddr";
import { blake2b256 } from "@multiformats/blake2/blake2b";
import { sha256 } from "multiformats/hashes/sha2";
import { from as hasherFrom } from "multiformats/hashes/hasher";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { BULLETIN_PEERS, IPFS_GATEWAY } from "./config";
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
    // Race bitswap (P2P) vs trustless gateway (HTTP) internally.
    // Both are hash-verified — the gateway is trustless, not trusted.
    blockBrokers: [bitswap(), trustlessGateway()],
    routers: [httpGatewayRouting({ gateways: [IPFS_GATEWAY] })],
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
        identifyPush: identifyPush(),
        ping: ping(),
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
  console.warn(`[dot.li fetch] createHelia() done (${dur(createStart)})`);

  // Dial all peers in parallel; proceed as soon as the first connects.
  // Remaining peers continue connecting in the background for redundancy.
  onStatus?.("Connecting to Bulletin Chain peers...");
  const dialStart = performance.now();
  const helia = heliaInstance;
  const dialPromises = BULLETIN_PEERS.map(async (addr) => {
    const peerStart = performance.now();
    try {
      await helia.libp2p.dial(multiaddr(addr));
      console.warn(
        `[dot.li fetch] Peer dialed (${dur(peerStart)}): ${addr.slice(-20)}`,
      );
    } catch (err) {
      console.warn(
        `[dot.li fetch] Peer failed (${dur(peerStart)}): ${addr.slice(-20)}`,
      );
      throw err;
    }
  });

  try {
    await Promise.any(dialPromises);
  } catch {
    throw new Error("Could not connect to any Bulletin Chain peers");
  }

  // Keep dialing remaining peers in background for redundancy
  void Promise.allSettled(dialPromises).then(() => {
    const total = helia.libp2p.getConnections().length;
    console.warn(
      `[dot.li fetch] All peers settled (${dur(dialStart)}), ${String(total)} connected`,
    );
  });

  const connections = helia.libp2p.getConnections();
  console.warn(
    `[dot.li fetch] First peer connected (${dur(dialStart)}), ${String(connections.length)} connected so far`,
  );
  onStatus?.(`Connected to Bulletin peer, dialing others...`);

  console.warn(`[dot.li fetch] ensureHelia() total: ${dur(heliaStart)}`);
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
 * Helia internally races bitswap (P2P) vs trustless gateway (HTTP) — both
 * are hash-verified. The trustless gateway provides fast fallback when
 * Bulletin peers don't have content in their bitswap cache.
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

  // For dag-pb (UnixFS) content — could be a file or directory
  if (cid.code === 0x70) {
    console.warn(`[dot.li fetch] P2P: fetching dag-pb (UnixFS) CID...`);
    const fs = unixfs(helia);

    // Try as file first
    try {
      const content = await collectCat(fs, cid, signal);
      console.warn(
        `[dot.li fetch] P2P: fetched file ${String(Math.round(content.length / 1024))} KB in ${dur(p2pStart)}`,
      );
      // Content may be a CAR archive (e.g. deployed via web-hosting tooling)
      if (isCarFile(content)) {
        console.warn(`[dot.li fetch] P2P: content is a CAR file, parsing...`);
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
    console.warn(`[dot.li fetch] P2P: CID is a directory, walking entries...`);
    onStatus?.("Fetching directory via P2P...");
    const files: ArchiveFiles = {};

    async function walkDir(dirCid: CID, prefix: string): Promise<void> {
      for await (const entry of fs.ls(dirCid, { signal })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        try {
          files[path] = await collectCat(fs, entry.cid, signal);
        } catch (catErr) {
          // If cat fails with "not a file", it's a subdirectory — recurse
          if (
            catErr instanceof Error &&
            catErr.message.includes("not a file")
          ) {
            await walkDir(entry.cid, path);
          }
        }
      }
    }

    await walkDir(cid, "");
    console.warn(
      `[dot.li fetch] P2P: fetched directory (${String(Object.keys(files).length)} files) in ${dur(p2pStart)}`,
    );
    return toFetchResult(files);
  }

  // For raw blocks, fetch directly from blockstore
  console.warn(`[dot.li fetch] P2P: fetching raw block...`);
  const blockData = helia.blockstore.get(cid, { signal });
  if (blockData instanceof Uint8Array) {
    console.warn(
      `[dot.li fetch] P2P: fetched ${String(Math.round(blockData.length / 1024))} KB in ${dur(p2pStart)}`,
    );
    return { type: "single", content: blockData };
  }

  throw new Error(`Unexpected block data type for CID ${cidString}`);
}

// ── Multi-file archive support ─────────────────────────────

export type FetchResult =
  | { type: "single"; content: Uint8Array }
  | { type: "archive"; files: ArchiveFiles };

/**
 * Fetch content as CAR archive from the IPFS gateway.
 * The gateway's ?format=car returns the entire directory tree in one response.
 */
async function fetchCarFromGateway(
  cidString: string,
  onStatus?: StatusCallback,
): Promise<Uint8Array> {
  const url = `${IPFS_GATEWAY}/ipfs/${cidString}?format=car`;
  onStatus?.("Fetching archive from IPFS gateway...");
  const carStart = performance.now();

  const response = await fetch(url, {
    headers: { Accept: "application/vnd.ipld.car" },
  });

  if (!response.ok) {
    throw new Error(
      `Gateway CAR fetch failed: HTTP ${String(response.status)}`,
    );
  }

  const buffer = await response.arrayBuffer();
  console.warn(
    `[dot.li fetch] Gateway CAR: fetched ${String(Math.round(buffer.byteLength / 1024))} KB in ${dur(carStart)}`,
  );
  return new Uint8Array(buffer);
}

/**
 * Fetch content by CID via P2P, with gateway fallback after 60s.
 * Supports both single files and multi-file directories.
 */
export async function fetchArchive(
  cidString: string,
  onStatus?: StatusCallback,
): Promise<FetchResult> {
  // Try P2P with 60s timeout
  try {
    performance.mark("dotli:fetch:p2p:start");
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 60_000);
    try {
      const result = await fetchViaP2P(cidString, onStatus, controller.signal);
      clearTimeout(timer);
      performance.mark("dotli:fetch:p2p:end");
      return result;
    } catch (err) {
      clearTimeout(timer);
      performance.mark("dotli:fetch:p2p:end");
      if (!controller.signal.aborted) {
        throw err;
      }
      console.warn(
        "[dot.li fetch] P2P timed out (60s), falling back to gateway...",
      );
      onStatus?.("P2P timeout, trying gateway...");
    }
  } catch (p2pError) {
    performance.mark("dotli:fetch:p2p:end");
    onStatus?.(
      `P2P failed (${(p2pError as Error).message}), trying gateway...`,
    );
  }

  // Gateway fallback — fetch as CAR archive
  performance.mark("dotli:fetch:gateway:start");
  const carBuffer = await fetchCarFromGateway(cidString, onStatus);
  performance.mark("dotli:fetch:gateway:end");
  onStatus?.("Parsing content...");
  performance.mark("dotli:fetch:parse:start");
  const files = await parseIpfsResponse(carBuffer);
  performance.mark("dotli:fetch:parse:end");
  return toFetchResult(files);
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
  console.warn(
    `[dot.li] Loaded archive with ${String(fileCount)} file(s):`,
    keys,
  );
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
