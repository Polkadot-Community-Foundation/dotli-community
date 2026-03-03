// dot.li — Content fetching from Bulletin Chain
//
// Primary: Helia P2P (in-browser libp2p node dials Bulletin peers via bitswap)
// Fallback: IPFS gateway HTTP fetch
//
// Pattern from: polkadot-bulletin-chain-main/console-ui/src/lib/helia.ts

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
async function ensureHelia(onStatus?: StatusCallback): Promise<Helia> {
  if (heliaInstance) return heliaInstance;

  onStatus?.("Initializing P2P client...");

  // Extract peer IDs for whitelist
  const allowedPeerIds = new Set<string>();
  for (const addr of BULLETIN_PEERS) {
    const match = addr.match(/\/p2p\/([^/]+)/);
    if (match?.[1]) allowedPeerIds.add(match[1]);
  }

  heliaInstance = await createHelia({
    hashers: [blake2b256, sha256, keccak256Hasher],
    libp2p: {
      connectionGater: {
        denyDialMultiaddr: async (maAddr) => {
          const addr = maAddr.toString();
          const match = addr.match(/\/p2p\/([^/]+)/);
          if (match?.[1] && allowedPeerIds.has(match[1])) return false;
          return true;
        },
      },
    },
  });

  // Connect to Bulletin peers
  onStatus?.("Connecting to Bulletin Chain peers...");
  for (const addr of BULLETIN_PEERS) {
    try {
      await heliaInstance.libp2p.dial(multiaddr(addr));
    } catch {
      // Some peers may be unavailable, continue with others
    }
  }

  const connections = heliaInstance.libp2p.getConnections();
  onStatus?.(`Connected to ${connections.length} Bulletin peer(s)`);

  if (connections.length === 0) {
    throw new Error("Could not connect to any Bulletin Chain peers");
  }

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

  // For dag-pb (UnixFS) content, use the unixfs accessor
  if (cid.code === 0x70) {
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
    return result;
  }

  // For raw blocks, fetch directly from blockstore
  const blockData = await helia.blockstore.get(cid);
  if (blockData instanceof Uint8Array) return blockData;

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

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Gateway fetch failed: HTTP ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
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

/**
 * Cleanup Helia instance.
 */
export async function destroyHelia(): Promise<void> {
  if (heliaInstance) {
    await heliaInstance.stop();
    heliaInstance = null;
  }
}
