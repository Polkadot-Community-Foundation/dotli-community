// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// PCF fork: devnet's parachains are not in truapi-provider's catalog, so the
// light-client transports cannot serve it. Own file because the network
// override below is module state and would leak into the other suites.

import { describe, it, expect, beforeEach } from "vitest";
import {
  BACKEND_KEY,
  configureModeStorage,
  defaultBackend,
  getBackend,
  type ModeStorage,
} from "@dotli/config/mode";
import {
  NetworkName,
  activeNetworkSupportsLightClient,
  setNetworkOverride,
} from "@dotli/config/network";

function makeMemoryStorage(): ModeStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe("devnet transport", () => {
  let storage: ReturnType<typeof makeMemoryStorage>;

  beforeEach(() => {
    storage = makeMemoryStorage();
    configureModeStorage(storage);
    setNetworkOverride(NetworkName.DEVNET);
  });

  it("marks devnet as unsupported by the light client", () => {
    expect(activeNetworkSupportsLightClient()).toBe(false);
  });

  it("defaults to rpc-gateway", () => {
    expect(defaultBackend()).toBe("rpc-gateway");
    expect(getBackend()).toBe("rpc-gateway");
    expect(storage.map.has(BACKEND_KEY)).toBe(false);
  });

  it("serves rpc-gateway over a stored light-client choice without erasing it", () => {
    storage.setItem(BACKEND_KEY, "smoldot-direct");
    expect(getBackend()).toBe("rpc-gateway");
    expect(storage.getItem(BACKEND_KEY)).toBe("smoldot-direct");
  });

  it("keeps the light client on networks whose chains the catalog carries", () => {
    setNetworkOverride(NetworkName.PASEO);
    expect(activeNetworkSupportsLightClient()).toBe(true);
    expect(defaultBackend()).toBe("smoldot-direct");
    storage.setItem(BACKEND_KEY, "smoldot-direct");
    expect(getBackend()).toBe("smoldot-direct");
  });
});
