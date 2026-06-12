// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import {
  BACKEND_KEY,
  configureModeStorage,
  defaultBackend,
  getBackend,
  isRpcGatewayOnly,
  isSharedWorkerAvailable,
  type ModeStorage,
} from "@dotli/config/mode";
import { NetworkName, setNetworkOverride } from "@dotli/config/network";

// The default network (Summit) is rpc-gateway-only, which would mask the
// smoldot selection logic under test. Pin a network with published
// parachain specs; the Summit-specific behavior has its own suite below.
beforeAll(() => {
  setNetworkOverride(NetworkName.PASEO_NEXT_V2);
});

function makeMemoryStorage(): ModeStorage & {
  dump: () => Record<string, string>;
} {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

const globalAny = globalThis as { SharedWorker?: unknown };

function installSharedWorker(): () => void {
  const hadPrior = "SharedWorker" in globalAny;
  const prior = globalAny.SharedWorker;
  globalAny.SharedWorker = class {};
  return () => {
    if (hadPrior) {
      globalAny.SharedWorker = prior;
    } else {
      delete globalAny.SharedWorker;
    }
  };
}

function ensureNoSharedWorker(): () => void {
  const hadPrior = "SharedWorker" in globalAny;
  const prior = globalAny.SharedWorker;
  if (hadPrior) {
    delete globalAny.SharedWorker;
  }
  return () => {
    if (hadPrior) {
      globalAny.SharedWorker = prior;
    }
  };
}

describe("isSharedWorkerAvailable", () => {
  it("returns true when SharedWorker is defined", () => {
    const restore = installSharedWorker();
    try {
      expect(isSharedWorkerAvailable()).toBe(true);
    } finally {
      restore();
    }
  });

  it("returns false when SharedWorker is undefined", () => {
    const restore = ensureNoSharedWorker();
    try {
      expect(isSharedWorkerAvailable()).toBe(false);
    } finally {
      restore();
    }
  });
});

describe("defaultBackend", () => {
  it("returns smoldot-shared-worker when SharedWorker is available", () => {
    const restore = installSharedWorker();
    try {
      expect(defaultBackend()).toBe("smoldot-shared-worker");
    } finally {
      restore();
    }
  });

  it("returns smoldot-direct when SharedWorker is missing", () => {
    const restore = ensureNoSharedWorker();
    try {
      expect(defaultBackend()).toBe("smoldot-direct");
    } finally {
      restore();
    }
  });
});

describe("getBackend", () => {
  let storage: ReturnType<typeof makeMemoryStorage>;

  beforeEach(() => {
    storage = makeMemoryStorage();
    configureModeStorage(storage);
  });

  afterEach(() => {
    configureModeStorage({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
  });

  it("seeds smoldot-shared-worker on first visit when supported", () => {
    const restore = installSharedWorker();
    try {
      expect(getBackend()).toBe("smoldot-shared-worker");
      expect(storage.dump()[BACKEND_KEY]).toBe("smoldot-shared-worker");
    } finally {
      restore();
    }
  });

  it("seeds smoldot-direct on first visit when SharedWorker is missing", () => {
    const restore = ensureNoSharedWorker();
    try {
      expect(getBackend()).toBe("smoldot-direct");
      expect(storage.dump()[BACKEND_KEY]).toBe("smoldot-direct");
    } finally {
      restore();
    }
  });

  it("downgrades persisted smoldot-shared-worker and clears the key when unsupported", () => {
    storage.setItem(BACKEND_KEY, "smoldot-shared-worker");
    const restore = ensureNoSharedWorker();
    try {
      expect(getBackend()).toBe("smoldot-direct");
      expect(storage.dump()[BACKEND_KEY]).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("keeps persisted smoldot-direct untouched even when SharedWorker is available", () => {
    storage.setItem(BACKEND_KEY, "smoldot-direct");
    const restore = installSharedWorker();
    try {
      expect(getBackend()).toBe("smoldot-direct");
      expect(storage.dump()[BACKEND_KEY]).toBe("smoldot-direct");
    } finally {
      restore();
    }
  });

  it("keeps persisted smoldot-shared-worker untouched when supported", () => {
    storage.setItem(BACKEND_KEY, "smoldot-shared-worker");
    const restore = installSharedWorker();
    try {
      expect(getBackend()).toBe("smoldot-shared-worker");
      expect(storage.dump()[BACKEND_KEY]).toBe("smoldot-shared-worker");
    } finally {
      restore();
    }
  });
});

describe("rpc-gateway-only networks (summit)", () => {
  let storage: ReturnType<typeof makeMemoryStorage>;

  beforeEach(() => {
    storage = makeMemoryStorage();
    configureModeStorage(storage);
    setNetworkOverride(NetworkName.SUMMIT);
  });

  afterEach(() => {
    setNetworkOverride(NetworkName.PASEO_NEXT_V2);
    configureModeStorage({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
  });

  it("reports summit as rpc-gateway-only", () => {
    expect(isRpcGatewayOnly(NetworkName.SUMMIT)).toBe(true);
    expect(isRpcGatewayOnly(NetworkName.PASEO_NEXT_V2)).toBe(false);
  });

  it("defaults to rpc-gateway even when SharedWorker is available", () => {
    const restore = installSharedWorker();
    try {
      expect(defaultBackend()).toBe("rpc-gateway");
    } finally {
      restore();
    }
  });

  it("forces rpc-gateway over a persisted smoldot preference without clobbering it", () => {
    storage.setItem(BACKEND_KEY, "smoldot-shared-worker");
    const restore = installSharedWorker();
    try {
      expect(getBackend()).toBe("rpc-gateway");
      // The stored preference survives so it resumes if specs arrive.
      expect(storage.dump()[BACKEND_KEY]).toBe("smoldot-shared-worker");
    } finally {
      restore();
    }
  });

  it("resumes the stored smoldot preference on a spec-capable network", () => {
    storage.setItem(BACKEND_KEY, "smoldot-shared-worker");
    const restore = installSharedWorker();
    try {
      setNetworkOverride(NetworkName.PASEO_NEXT_V2);
      expect(getBackend()).toBe("smoldot-shared-worker");
    } finally {
      restore();
    }
  });
});
