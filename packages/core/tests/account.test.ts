import { describe, it, expect } from "vitest";
import { deriveProductPublicKey } from "@dotli/core/account";
import { secretFromSeed, getPublicKey } from "@scure/sr25519";

describe("deriveProductPublicKey", () => {
  // Generate a valid SR25519 public key from a deterministic seed
  const seed = new Uint8Array(32);
  seed[0] = 0x01;
  const secret = secretFromSeed(seed);
  const rootPublicKey = getPublicKey(secret);

  it("returns a 32-byte public key", () => {
    const derived = deriveProductPublicKey(rootPublicKey, "myapp.dot", 0);
    expect(derived).toBeInstanceOf(Uint8Array);
    expect(derived.length).toBe(32);
  });

  it("produces different keys for different product IDs", () => {
    const key1 = deriveProductPublicKey(rootPublicKey, "app1.dot", 0);
    const key2 = deriveProductPublicKey(rootPublicKey, "app2.dot", 0);
    expect(Buffer.from(key1).equals(Buffer.from(key2))).toBe(false);
  });

  it("produces different keys for different derivation indices", () => {
    const key1 = deriveProductPublicKey(rootPublicKey, "myapp.dot", 0);
    const key2 = deriveProductPublicKey(rootPublicKey, "myapp.dot", 1);
    expect(Buffer.from(key1).equals(Buffer.from(key2))).toBe(false);
  });

  it("is deterministic", () => {
    const key1 = deriveProductPublicKey(rootPublicKey, "test.dot", 5);
    const key2 = deriveProductPublicKey(rootPublicKey, "test.dot", 5);
    expect(Buffer.from(key1).equals(Buffer.from(key2))).toBe(true);
  });

  it("derives different key from root (soft derivation changes output)", () => {
    const derived = deriveProductPublicKey(rootPublicKey, "myapp.dot", 0);
    expect(Buffer.from(derived).equals(Buffer.from(rootPublicKey))).toBe(false);
  });
});
