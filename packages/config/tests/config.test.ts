import { describe, it, expect } from "vitest";
import {
  CONTRACTS,
  DOT_NODE,
  STORAGE_SLOTS,
  IPFS_GATEWAY,
  TIMEOUTS,
  SW_ARCHIVE_CACHE_MAX,
} from "@dotli/config/config";

describe("config constants", () => {
  describe("contract addresses", () => {
    it("DOTNS_REGISTRY is a valid hex address", () => {
      expect(CONTRACTS.DOTNS_REGISTRY).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("DOTNS_CONTENT_RESOLVER is a valid hex address", () => {
      expect(CONTRACTS.DOTNS_CONTENT_RESOLVER).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });
  });

  describe("DOT_NODE", () => {
    it("is a valid bytes32 hex string", () => {
      expect(DOT_NODE).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  describe("STORAGE_SLOTS", () => {
    it("REGISTRY_RECORDS is a non-negative integer", () => {
      expect(Number.isInteger(STORAGE_SLOTS.REGISTRY_RECORDS)).toBe(true);
      expect(STORAGE_SLOTS.REGISTRY_RECORDS).toBeGreaterThanOrEqual(0);
    });

    it("CONTENTHASH is a non-negative integer", () => {
      expect(Number.isInteger(STORAGE_SLOTS.CONTENTHASH)).toBe(true);
      expect(STORAGE_SLOTS.CONTENTHASH).toBeGreaterThanOrEqual(0);
    });
  });

  describe("IPFS_GATEWAY", () => {
    it("is a valid HTTPS URL", () => {
      expect(IPFS_GATEWAY).toMatch(/^https:\/\//);
    });
  });

  describe("TIMEOUTS", () => {
    it("all timeout values are positive numbers", () => {
      for (const [key, value] of Object.entries(TIMEOUTS)) {
        expect(value, `TIMEOUTS.${key}`).toBeGreaterThan(0);
      }
    });
  });

  describe("SW_ARCHIVE_CACHE_MAX", () => {
    it("is a positive number", () => {
      expect(SW_ARCHIVE_CACHE_MAX).toBeGreaterThan(0);
    });
  });
});
