import { describe, it, expect, beforeEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { extractAndSaveChainDb, type ChainRpc } from "@dotli/core/db";

// Reset the module-level singleton between tests
beforeEach(async () => {
  // Delete all databases
  const dbs = await indexedDB.databases();
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name);
  }
});

describe("extractAndSaveChainDb", () => {
  it("sends JSON-RPC and saves response to IndexedDB", async () => {
    const dbContent = "mock-chain-database-content";
    let sentRpc = "";

    const mockChain: ChainRpc = {
      sendJsonRpc: (rpc: string) => {
        sentRpc = rpc;
      },
      nextJsonRpcResponse: async () => {
        const parsed = JSON.parse(sentRpc) as { id: number };
        return JSON.stringify({ id: parsed.id, result: dbContent });
      },
    };

    const logFn = vi.fn();
    await extractAndSaveChainDb(mockChain, 1_000_000, logFn, "[test]");

    // Verify JSON-RPC was sent correctly
    const parsed = JSON.parse(sentRpc) as {
      method: string;
      params: number[];
    };
    expect(parsed.method).toBe("chainHead_unstable_finalizedDatabase");
    expect(parsed.params).toEqual([1_000_000]);

    // Verify log was called
    expect(logFn).toHaveBeenCalledOnce();
    expect(logFn.mock.calls[0][0]).toContain("[test]");
    expect(logFn.mock.calls[0][0]).toContain("Saved relay chain DB");
  });

  it("does not throw on JSON-RPC failure", async () => {
    const mockChain: ChainRpc = {
      sendJsonRpc: () => {
        throw new Error("send failed");
      },
      nextJsonRpcResponse: async () => "",
    };

    const logFn = vi.fn();
    await expect(
      extractAndSaveChainDb(mockChain, 1_000_000, logFn, "[test]"),
    ).resolves.not.toThrow();
  });

  it("does not save if response id does not match", async () => {
    const mockChain: ChainRpc = {
      sendJsonRpc: () => {},
      nextJsonRpcResponse: async () =>
        JSON.stringify({ id: 999, result: "data" }),
    };

    const logFn = vi.fn();
    await extractAndSaveChainDb(mockChain, 1_000_000, logFn, "[test]");
    // logFn should NOT be called since ids don't match
    expect(logFn).not.toHaveBeenCalled();
  });
});
