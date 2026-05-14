import { describe, it, expect } from "vitest";
import {
  deriveProductPublicKey,
  productPublicKeyToAddress,
} from "@dotli/auth/account";
import { AccountId } from "polkadot-api";
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

  it("supports long preview product IDs", () => {
    const derived = deriveProductPublicKey(
      rootPublicKey,
      "w-credentialless-staticblitz-com.local-credentialless.webcontainer-api.io",
      0,
    );
    expect(derived).toBeInstanceOf(Uint8Array);
    expect(derived.length).toBe(32);
  });

  it("derives different key from root (soft derivation changes output)", () => {
    const derived = deriveProductPublicKey(rootPublicKey, "myapp.dot", 0);
    expect(Buffer.from(derived).equals(Buffer.from(rootPublicKey))).toBe(false);
  });
});

describe("productPublicKeyToAddress", () => {
  const seed = new Uint8Array(32);
  seed[0] = 0x01;
  const rootPublicKey = getPublicKey(secretFromSeed(seed));

  it("round-trips with polkadot-api's AccountId() encoder", () => {
    const address = productPublicKeyToAddress(rootPublicKey);
    const reEncoded = AccountId().enc(address);
    expect(Buffer.from(reEncoded).equals(Buffer.from(rootPublicKey))).toBe(
      true,
    );
  });

  it("uses the substrate-generic (42) ss58 prefix by default", () => {
    // Prefix 42 always produces an SS58 string starting with '5' for 32-byte
    // public keys (mathematical property of base58 encoding of the prefix).
    const address = productPublicKeyToAddress(rootPublicKey);
    expect(address.startsWith("5")).toBe(true);
  });

  it("is deterministic", () => {
    const a = productPublicKeyToAddress(rootPublicKey);
    const b = productPublicKeyToAddress(rootPublicKey);
    expect(a).toBe(b);
  });

  it("produces distinct addresses for distinct keys", () => {
    const derived = deriveProductPublicKey(rootPublicKey, "myapp.dot", 0);
    expect(productPublicKeyToAddress(derived)).not.toBe(
      productPublicKeyToAddress(rootPublicKey),
    );
  });
});
