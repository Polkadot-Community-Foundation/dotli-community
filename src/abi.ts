// dot.li — Minimal ABI helpers for dotNS contract calls
//
// Replaces viem's namehash, encodeFunctionData, and decodeFunctionResult
// with ~80 lines using @noble/hashes (already a dependency).
// All our contract calls take a single bytes32 argument and return
// one of: bytes (dynamic), bool, or address.

import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  decode as decodeContentHash,
  getCodec,
} from "@ensdomains/content-hash";

function toHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ── namehash (ENS EIP-137) ──────────────────────────────────

export function namehash(name: string): `0x${string}` {
  let node = new Uint8Array(32); // 0x00...00
  if (name === "") {
    return toHex(node);
  }
  const labels = name.split(".").reverse();
  for (const label of labels) {
    const labelHash = keccak_256(new TextEncoder().encode(label));
    const combined = new Uint8Array(64);
    combined.set(node, 0);
    combined.set(labelHash, 32);
    node = new Uint8Array(keccak_256(combined));
  }
  return toHex(node);
}

// ── ABI encoding ────────────────────────────────────────────
// All dotNS calls: selector(4 bytes) + bytes32 arg (32 bytes)

// Pre-computed selectors: keccak256("fn(bytes32)") first 4 bytes
const SELECTORS = {
  contenthash: "bc1c58d1",
  owner: "02571be3",
  recordExists: "f79fe538",
} as const;

type FunctionName = keyof typeof SELECTORS;

export function encodeFunctionCall(
  functionName: FunctionName,
  node: `0x${string}`,
): `0x${string}` {
  const selector = SELECTORS[functionName];
  const arg = node.slice(2).padStart(64, "0");
  return `0x${selector}${arg}` as `0x${string}`;
}

// ── ABI decoding ────────────────────────────────────────────

export function decodeBytes(data: `0x${string}`): `0x${string}` {
  const hex = data.slice(2);
  if (hex.length < 128) {
    return "0x";
  }
  // ABI dynamic bytes: offset (32 bytes) + length (32 bytes) + data
  const offset = parseInt(hex.slice(0, 64), 16) * 2;
  const length = parseInt(hex.slice(offset, offset + 64), 16) * 2;
  const bytesHex = hex.slice(offset + 64, offset + 64 + length);
  return `0x${bytesHex}`;
}

export function decodeAddress(data: `0x${string}`): string {
  // ABI address: right-aligned 20 bytes in a 32-byte word
  const hex = data.slice(2);
  if (hex.length < 64) {
    return "0x0000000000000000000000000000000000000000";
  }
  return `0x${hex.slice(24, 64)}`;
}

// ── Contenthash decoding ──────────────────────────────────

/** Decode contenthash bytes (ENS-style) into an IPFS CID string. */
export function decodeIpfsContenthash(contenthashHex: string): string | null {
  const hex = contenthashHex.startsWith("0x")
    ? contenthashHex.slice(2)
    : contenthashHex;
  if (!hex || hex === "0" || hex.length < 4) {
    return null;
  }
  try {
    if (getCodec(hex) !== "ipfs") {
      return null;
    }
    return decodeContentHash(hex) || null;
  } catch {
    return null;
  }
}

// Verify selectors at module load (development safety net, tree-shaken in prod)
if (import.meta.env.DEV) {
  for (const [name, expected] of Object.entries(SELECTORS)) {
    const sig = `${name}(bytes32)`;
    const hash = keccak_256(new TextEncoder().encode(sig));
    const actual = toHex(hash.slice(0, 4)).slice(2);
    if (actual !== expected) {
      console.error(
        `[dot.li abi] Selector mismatch for ${sig}: expected ${expected}, got ${actual}`,
      );
    }
  }
}
