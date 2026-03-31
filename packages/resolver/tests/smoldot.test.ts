import { describe, it, expect, vi, beforeEach } from "vitest";

// We need to mock smoldot and chain-specs before importing the module
vi.mock("polkadot-api/smoldot/from-worker", () => {
  const mockAddChain = vi.fn().mockResolvedValue({
    sendJsonRpc: vi.fn(),
    nextJsonRpcResponse: vi.fn(),
    jsonRpcResponses: (async function* () {})(),
    remove: vi.fn(),
  });
  return {
    startFromWorker: vi.fn(() => ({
      addChain: mockAddChain,
    })),
  };
});

vi.mock("polkadot-api/smoldot/worker?worker", () => {
  return { default: class MockWorker {} };
});

vi.mock("@dotli/resolver/chain-specs", () => ({
  getPaseoChainSpec: vi.fn().mockResolvedValue('{"name":"paseo"}'),
  getAssetHubPaseoChainSpec: vi
    .fn()
    .mockResolvedValue('{"name":"asset-hub-paseo"}'),
}));

vi.mock("@dotli/storage/db", () => ({
  loadChainDb: vi.fn().mockResolvedValue(undefined),
  extractAndSaveChainDb: vi.fn().mockResolvedValue(undefined),
  saveChainDb: vi.fn().mockResolvedValue(undefined),
}));

// Must import AFTER mocks are set up
let getSmoldot: typeof import("@dotli/resolver/smoldot").getSmoldot;
let getRelayChain: typeof import("@dotli/resolver/smoldot").getRelayChain;
let releaseResolverMutex: typeof import("@dotli/resolver/smoldot").releaseResolverMutex;
let waitForResolverRelease: typeof import("@dotli/resolver/smoldot").waitForResolverRelease;
let makeNonRemovingChain: typeof import("@dotli/resolver/smoldot").makeNonRemovingChain;
let createResolverAssetHubChain: typeof import("@dotli/resolver/smoldot").createResolverAssetHubChain;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("@dotli/resolver/smoldot");
  getSmoldot = mod.getSmoldot;
  getRelayChain = mod.getRelayChain;
  releaseResolverMutex = mod.releaseResolverMutex;
  waitForResolverRelease = mod.waitForResolverRelease;
  makeNonRemovingChain = mod.makeNonRemovingChain;
  createResolverAssetHubChain = mod.createResolverAssetHubChain;
});

describe("getSmoldot", () => {
  it("returns the same instance on repeated calls", () => {
    const a = getSmoldot();
    const b = getSmoldot();
    expect(a).toBe(b);
  });
});

describe("getRelayChain", () => {
  it("returns a promise", () => {
    const result = getRelayChain();
    expect(result).toBeInstanceOf(Promise);
  });

  it("deduplicates concurrent calls", () => {
    const a = getRelayChain();
    const b = getRelayChain();
    expect(a).toBe(b);
  });

  it("resolves to a chain object", async () => {
    const chain = await getRelayChain();
    expect(chain).toBeDefined();
    expect(typeof chain.sendJsonRpc).toBe("function");
  });
});

describe("releaseResolverMutex / waitForResolverRelease", () => {
  it("localhost mode: skips mutex when no .dot name resolution happened", async () => {
    // In localhost mode, no resolver chain is created — the mutex
    // should not block dApp chainConnect requests for Asset Hub.
    let resolved = false;
    waitForResolverRelease().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it(".dot domain: blocks until resolution completes and releases mutex", async () => {
    // When resolving a .dot name, a temporary Asset Hub chain is created.
    // The mutex must block until that chain is destroyed to prevent
    // smoldot from panicking on duplicate chains.
    await createResolverAssetHubChain();

    let resolved = false;
    const waiting = waitForResolverRelease().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    releaseResolverMutex();
    await waiting;
    expect(resolved).toBe(true);
  });

  it("releaseResolverMutex is idempotent (double call does not throw)", () => {
    releaseResolverMutex();
    expect(() => releaseResolverMutex()).not.toThrow();
  });
});

describe("makeNonRemovingChain", () => {
  it("delegates sendJsonRpc and nextJsonRpcResponse", () => {
    const mockSend = vi.fn();
    const mockNext = vi.fn().mockResolvedValue("response");
    const mockChain = {
      sendJsonRpc: mockSend,
      nextJsonRpcResponse: mockNext,
      jsonRpcResponses: (async function* () {})(),
      remove: vi.fn(),
    };

    const wrapped = makeNonRemovingChain(
      mockChain as unknown as Awaited<ReturnType<typeof getRelayChain>>,
    );
    wrapped.sendJsonRpc("test");
    expect(mockSend).toHaveBeenCalledWith("test");

    void wrapped.nextJsonRpcResponse();
    expect(mockNext).toHaveBeenCalled();
  });

  it("suppresses remove() call", () => {
    const mockRemove = vi.fn();
    const mockChain = {
      sendJsonRpc: vi.fn(),
      nextJsonRpcResponse: vi.fn(),
      jsonRpcResponses: (async function* () {})(),
      remove: mockRemove,
    };

    const wrapped = makeNonRemovingChain(
      mockChain as unknown as Awaited<ReturnType<typeof getRelayChain>>,
    );
    wrapped.remove();
    expect(mockRemove).not.toHaveBeenCalled();
  });
});
