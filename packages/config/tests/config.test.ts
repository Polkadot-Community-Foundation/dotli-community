import { describe, it, expect } from "vitest";
import { DOT_NODE, TIMEOUTS, SW_ARCHIVE_CACHE_MAX } from "@dotli/config/config";
import {
  NETWORK_NAME_TO_SERVICES_CONFIG,
  NetworkName,
} from "@dotli/config/network";

describe("config constants", () => {
  describe("contract addresses", () => {
    const v1 = NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO_NEXT_V1].dotns;
    const v2 = NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO_NEXT_V2].dotns;

    it("V1 DOTNS_REGISTRY is a valid hex address", () => {
      expect(v1.DOTNS_REGISTRY).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("V1 DOTNS_CONTENT_RESOLVER is a valid hex address", () => {
      expect(v1.DOTNS_CONTENT_RESOLVER).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("V2 DOTNS_REGISTRY is a valid hex address", () => {
      expect(v2.DOTNS_REGISTRY).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("V2 DOTNS_CONTENT_RESOLVER is a valid hex address", () => {
      expect(v2.DOTNS_CONTENT_RESOLVER).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("V1 and V2 contract addresses differ (separate deployments)", () => {
      expect(v1.DOTNS_REGISTRY).not.toBe(v2.DOTNS_REGISTRY);
      expect(v1.DOTNS_CONTENT_RESOLVER).not.toBe(v2.DOTNS_CONTENT_RESOLVER);
    });
  });

  describe("DOT_NODE", () => {
    it("is a valid bytes32 hex string", () => {
      expect(DOT_NODE).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  describe("dotns storage slots", () => {
    it("every network exposes non-negative REGISTRY_RECORDS and CONTENTHASH slots", () => {
      for (const cfg of Object.values(NETWORK_NAME_TO_SERVICES_CONFIG)) {
        const slots = cfg.dotns.storageSlots;
        expect(Number.isInteger(slots.REGISTRY_RECORDS)).toBe(true);
        expect(slots.REGISTRY_RECORDS).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(slots.CONTENTHASH)).toBe(true);
        expect(slots.CONTENTHASH).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("IPFS gateways", () => {
    it("V1 first gateway is a valid HTTPS URL", () => {
      expect(
        NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO_NEXT_V1].bulletin
          .ipfsGateways[0],
      ).toMatch(/^https:\/\//);
    });

    it("V2 first gateway is a valid HTTPS URL", () => {
      expect(
        NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO_NEXT_V2].bulletin
          .ipfsGateways[0],
      ).toMatch(/^https:\/\//);
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
