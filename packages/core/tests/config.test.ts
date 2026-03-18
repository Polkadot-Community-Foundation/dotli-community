import { describe, it, expect } from "vitest";
import {
  CONTRACTS,
  DOT_NODE,
  DRY_RUN_WEIGHT_LIMIT,
  DRY_RUN_STORAGE_LIMIT,
  DUMMY_ORIGIN,
  BULLETIN_PEERS,
  IPFS_GATEWAY,
  ASSET_HUB_PASEO_RPC,
  TIMEOUTS,
  FINALIZED_DB_MAX_SIZE,
  SW_ARCHIVE_CACHE_MAX,
} from "@dotli/core/config";

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

  describe("dry-run limits", () => {
    it("weight limit has ref_time and proof_size as bigints", () => {
      expect(typeof DRY_RUN_WEIGHT_LIMIT.ref_time).toBe("bigint");
      expect(typeof DRY_RUN_WEIGHT_LIMIT.proof_size).toBe("bigint");
      expect(DRY_RUN_WEIGHT_LIMIT.ref_time).toBeGreaterThan(0n);
      expect(DRY_RUN_WEIGHT_LIMIT.proof_size).toBeGreaterThan(0n);
    });

    it("storage limit is a positive bigint", () => {
      expect(typeof DRY_RUN_STORAGE_LIMIT).toBe("bigint");
      expect(DRY_RUN_STORAGE_LIMIT).toBeGreaterThan(0n);
    });
  });

  describe("DUMMY_ORIGIN", () => {
    it("is a non-empty substrate address", () => {
      expect(DUMMY_ORIGIN).toMatch(/^5[a-zA-Z0-9]+$/);
      expect(DUMMY_ORIGIN.length).toBeGreaterThan(40);
    });
  });

  describe("BULLETIN_PEERS", () => {
    it("is a non-empty array", () => {
      expect(BULLETIN_PEERS.length).toBeGreaterThan(0);
    });

    it("each peer is a valid multiaddr with /wss/ transport", () => {
      for (const peer of BULLETIN_PEERS) {
        expect(peer).toMatch(/^\/dns4\//);
        expect(peer).toContain("/wss/");
        expect(peer).toContain("/p2p/");
      }
    });
  });

  describe("IPFS_GATEWAY", () => {
    it("is a valid HTTPS URL", () => {
      expect(IPFS_GATEWAY).toMatch(/^https:\/\//);
    });
  });

  describe("ASSET_HUB_PASEO_RPC", () => {
    it("has at least one WSS endpoint", () => {
      expect(ASSET_HUB_PASEO_RPC.length).toBeGreaterThan(0);
      for (const url of ASSET_HUB_PASEO_RPC) {
        expect(url).toMatch(/^wss:\/\//);
      }
    });
  });

  describe("TIMEOUTS", () => {
    it("all timeout values are positive numbers", () => {
      for (const [key, value] of Object.entries(TIMEOUTS)) {
        expect(value, `TIMEOUTS.${key}`).toBeGreaterThan(0);
      }
    });

    it("P2P_FETCH is the longest timeout", () => {
      expect(TIMEOUTS.P2P_FETCH).toBeGreaterThanOrEqual(
        TIMEOUTS.GATEWAY_RESOLVE,
      );
    });
  });

  describe("FINALIZED_DB_MAX_SIZE", () => {
    it("is a positive number", () => {
      expect(FINALIZED_DB_MAX_SIZE).toBeGreaterThan(0);
    });
  });

  describe("SW_ARCHIVE_CACHE_MAX", () => {
    it("is a positive number", () => {
      expect(SW_ARCHIVE_CACHE_MAX).toBeGreaterThan(0);
    });
  });
});
