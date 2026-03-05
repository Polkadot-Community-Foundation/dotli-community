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
 * Fetch content via Helia P2P from Bulletin Chain.
 * Handles both raw blocks and UnixFS (dag-pb) content.
 */
async function fetchViaP2P(
  cidString: string,
  onStatus?: StatusCallback,
): Promise<Uint8Array> {
  const helia = await ensureHelia(onStatus);
  const cid = CID.parse(cidString);

  onStatus?.("Fetching content via P2P...");
  const p2pStart = performance.now();

  // For dag-pb (UnixFS) content, use the unixfs accessor
  if (cid.code === 0x70) {
    console.warn(`[dot.li fetch] P2P: fetching dag-pb (UnixFS) CID...`);
    const fs = unixfs(helia);
    const chunks: Uint8Array[] = [];
    for await (const chunk of fs.cat(cid)) {
      chunks.push(chunk);
    }
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    console.warn(
      `[dot.li fetch] P2P: fetched ${String(Math.round(totalLength / 1024))} KB in ${dur(p2pStart)}`,
    );
    return result;
  }

  // For raw blocks, fetch directly from blockstore
  console.warn(`[dot.li fetch] P2P: fetching raw block...`);
  const blockData = helia.blockstore.get(cid);
  if (blockData instanceof Uint8Array) {
    console.warn(
      `[dot.li fetch] P2P: fetched ${String(Math.round(blockData.length / 1024))} KB in ${dur(p2pStart)}`,
    );
    return blockData;
  }

  throw new Error(`Unexpected block data type for CID ${cidString}`);
}

/**
 * Fetch content via IPFS gateway (HTTP fallback).
 */
async function fetchViaGateway(
  cidString: string,
  onStatus?: StatusCallback,
): Promise<Uint8Array> {
  const url = `${IPFS_GATEWAY}/ipfs/${cidString}`;
  onStatus?.("Fetching content via IPFS gateway...");
  const gwStart = performance.now();

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Gateway fetch failed: HTTP ${String(response.status)}`);
  }

  const buffer = await response.arrayBuffer();
  console.warn(
    `[dot.li fetch] Gateway: fetched ${String(Math.round(buffer.byteLength / 1024))} KB in ${dur(gwStart)}`,
  );
  return new Uint8Array(buffer);
}

/**
 * Fetch content by CID from Bulletin Chain.
 * Tries P2P first, falls back to IPFS gateway on failure.
 */
export async function fetchContent(
  cidString: string,
  onStatus?: StatusCallback,
): Promise<Uint8Array> {
  // Try P2P first
  try {
    return await fetchViaP2P(cidString, onStatus);
  } catch (p2pError) {
    onStatus?.(
      `P2P failed (${(p2pError as Error).message}), trying gateway...`,
    );
  }

  // Fallback to gateway
  return await fetchViaGateway(cidString, onStatus);
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
 * Fetch content by CID, supporting both single files and multi-file directories.
 *
 * Strategy:
 * 1. Fetch via P2P first (works for single files on Bulletin Chain)
 * 2. If the fetched content is a CAR file (directory), parse it into an archive
 * 3. If P2P fails, try gateway with ?format=car (returns directory as CAR)
 * 4. Parse whatever we get — parseIpfsResponse handles both CAR and raw content
 */
export async function fetchArchive(
  cidString: string,
  onStatus?: StatusCallback,
): Promise<FetchResult> {
  // Try P2P first
  try {
    performance.mark("dotli:fetch:p2p:start");
    const content = await fetchViaP2P(cidString, onStatus);
    performance.mark("dotli:fetch:p2p:end");

    if (isCarFile(content)) {
      onStatus?.("Parsing archive...");
      performance.mark("dotli:fetch:parse:start");
      const files = await parseIpfsResponse(content);
      performance.mark("dotli:fetch:parse:end");
      return toFetchResult(files);
    }

    return { type: "single", content };
  } catch (p2pError) {
    performance.mark("dotli:fetch:p2p:end");
    onStatus?.(
      `P2P fetch failed (${(p2pError as Error).message}), trying gateway...`,
    );
  }

  // Gateway fallback — fetch as CAR archive
  try {
    performance.mark("dotli:fetch:gateway:start");
    const carBuffer = await fetchCarFromGateway(cidString, onStatus);
    performance.mark("dotli:fetch:gateway:end");
    onStatus?.("Parsing content...");
    performance.mark("dotli:fetch:parse:start");
    const files = await parseIpfsResponse(carBuffer);
    performance.mark("dotli:fetch:parse:end");
    return toFetchResult(files);
  } catch (carError) {
    performance.mark("dotli:fetch:gateway:end");
    onStatus?.(
      `CAR fetch failed (${(carError as Error).message}), trying raw gateway...`,
    );
  }

  // Last resort — raw gateway fetch
  const content = await fetchViaGateway(cidString, onStatus);
  return { type: "single", content };
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
