import { describe, it, expect } from "vitest";
import {
  namehash,
  encodeFunctionCall,
  decodeBytes,
  decodeAddress,
  decodeIpfsContenthash,
} from "@dotli/core/abi";

// ── namehash (ENS EIP-137) ──────────────────────────────────

describe("namehash", () => {
  it("returns 32 zero bytes for empty string", () => {
    expect(namehash("")).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("computes correct hash for 'eth'", () => {
    // Well-known ENS test vector
    expect(namehash("eth")).toBe(
      "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae",
    );
  });

  it("computes correct hash for 'foo.eth'", () => {
    expect(namehash("foo.eth")).toBe(
      "0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f",
    );
  });

  it("computes hash for .dot TLD", () => {
    const hash = namehash("dot");
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hash).not.toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("computes hash for myapp.dot", () => {
    const hash = namehash("myapp.dot");
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    // Must differ from just "dot"
    expect(hash).not.toBe(namehash("dot"));
  });

  it("produces different hashes for different labels", () => {
    expect(namehash("a.dot")).not.toBe(namehash("b.dot"));
  });

  it("is deterministic", () => {
    expect(namehash("test.dot")).toBe(namehash("test.dot"));
  });
});

// ── encodeFunctionCall ──────────────────────────────────────

describe("encodeFunctionCall", () => {
  const dummyNode =
    "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as `0x${string}`;

  it("encodes contenthash(bytes32) with correct selector", () => {
    const result = encodeFunctionCall("contenthash", dummyNode);
    expect(result).toMatch(/^0x/);
    // the selector is bc1c58d1
    expect(result.slice(0, 10)).toBe("0xbc1c58d1");
    // total: 0x + 8 chars selector + 64 chars arg = 74 chars
    expect(result.length).toBe(74);
  });

  it("encodes owner(bytes32) with correct selector", () => {
    const result = encodeFunctionCall("owner", dummyNode);
    expect(result.slice(0, 10)).toBe("0x02571be3");
  });

  it("encodes recordExists(bytes32) with correct selector", () => {
    const result = encodeFunctionCall("recordExists", dummyNode);
    expect(result.slice(0, 10)).toBe("0xf79fe538");
  });

  it("pads short node values to 64 hex chars", () => {
    const shortNode = "0xabcd" as `0x${string}`;
    const result = encodeFunctionCall("contenthash", shortNode);
    // 0x + 8 selector + 64 padded arg
    expect(result.length).toBe(74);
    expect(result.endsWith("abcd")).toBe(true);
  });
});

// ── decodeBytes ────────────────────────────────────────────

describe("decodeBytes", () => {
  it("decodes ABI-encoded dynamic bytes", () => {
    // offset = 0x20 (32), length = 0x04 (4 bytes), data = "deadbeef"
    const data =
      "0x" +
      "0000000000000000000000000000000000000000000000000000000000000020" + // offset
      "0000000000000000000000000000000000000000000000000000000000000004" + // length
      "deadbeef00000000000000000000000000000000000000000000000000000000"; // data + padding
    const result = decodeBytes(data as `0x${string}`);
    expect(result).toBe("0xdeadbeef");
  });

  it("returns 0x for too-short data", () => {
    expect(decodeBytes("0xabcd" as `0x${string}`)).toBe("0x");
  });

  it("returns 0x for empty hex", () => {
    expect(decodeBytes("0x" as `0x${string}`)).toBe("0x");
  });

  it("handles zero-length bytes correctly", () => {
    const data =
      "0x" +
      "0000000000000000000000000000000000000000000000000000000000000020" +
      "0000000000000000000000000000000000000000000000000000000000000000"; // length = 0
    const result = decodeBytes(data as `0x${string}`);
    expect(result).toBe("0x");
  });
});

// ── decodeAddress ──────────────────────────────────────────

describe("decodeAddress", () => {
  it("extracts 20-byte address from right-aligned 32-byte word", () => {
    const data =
      "0x000000000000000000000000aabbccddee11223344556677889900aabbccddee" as `0x${string}`;
    expect(decodeAddress(data)).toBe(
      "0xaabbccddee11223344556677889900aabbccddee",
    );
  });

  it("returns zero address for too-short data", () => {
    expect(decodeAddress("0xabcd" as `0x${string}`)).toBe(
      "0x0000000000000000000000000000000000000000",
    );
  });

  it("returns zero address for empty data", () => {
    expect(decodeAddress("0x" as `0x${string}`)).toBe(
      "0x0000000000000000000000000000000000000000",
    );
  });

  it("decodes actual zero address", () => {
    const data =
      "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
    expect(decodeAddress(data)).toBe(
      "0x0000000000000000000000000000000000000000",
    );
  });
});

// ── decodeIpfsContenthash ──────────────────────────────────

describe("decodeIpfsContenthash", () => {
  it("returns null for empty hex", () => {
    expect(decodeIpfsContenthash("")).toBeNull();
    expect(decodeIpfsContenthash("0x")).toBeNull();
    expect(decodeIpfsContenthash("0x0")).toBeNull();
  });

  it("returns null for too-short hex", () => {
    expect(decodeIpfsContenthash("0xab")).toBeNull();
  });

  it("returns null for non-IPFS codec", () => {
    // Swarm codec prefix
    expect(decodeIpfsContenthash("0xe40101")).toBeNull();
  });

  it("decodes valid IPFS CIDv1 contenthash", () => {
    // Real ENS-encoded IPFS CIDv1: encode('ipfs', 'bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4')
    const validIpfsContenthash =
      "e3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f";
    const result = decodeIpfsContenthash(validIpfsContenthash);
    expect(result).not.toBeNull();
    expect(result).toBe(
      "bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4",
    );
  });

  it("handles 0x prefix", () => {
    const hex =
      "0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f";
    const hexWithout =
      "e3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f";
    expect(decodeIpfsContenthash(hex)).toBe(decodeIpfsContenthash(hexWithout));
  });
});
