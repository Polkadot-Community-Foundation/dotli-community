// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSharedAuthStorageAdapter } from "@dotli/auth/shared-storage";
import {
  clearSharedAuthStorage,
  readSharedAuthStorage,
  subscribeSharedAuthStorage,
  writeSharedAuthStorage,
  type SharedAuthStorageListener,
} from "@dotli/protocol/client";

vi.mock("@dotli/protocol/client", () => ({
  readSharedAuthStorage: vi.fn(),
  writeSharedAuthStorage: vi.fn(),
  clearSharedAuthStorage: vi.fn(),
  subscribeSharedAuthStorage: vi.fn(),
}));

describe("createSharedAuthStorageAdapter", () => {
  beforeEach(() => {
    vi.mocked(readSharedAuthStorage).mockReset();
    vi.mocked(writeSharedAuthStorage).mockReset();
    vi.mocked(clearSharedAuthStorage).mockReset();
    vi.mocked(subscribeSharedAuthStorage).mockReset();
    vi.mocked(subscribeSharedAuthStorage).mockReturnValue(() => {
      /* noop unsubscribe */
    });
  });

  it("reads from shared host storage for the requested site", async () => {
    vi.mocked(readSharedAuthStorage).mockResolvedValue("stored-value");

    const adapter = createSharedAuthStorageAdapter("dot.li");
    const result = await adapter.read("SsoSessions");

    expect(readSharedAuthStorage).toHaveBeenCalledWith("dot.li", "SsoSessions");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe("stored-value");
  });

  it("emits local subscribers after writes and clears", async () => {
    vi.mocked(writeSharedAuthStorage).mockResolvedValue(undefined);
    vi.mocked(clearSharedAuthStorage).mockResolvedValue(undefined);
    // After write/clear, the adapter reads back through the iframe
    // (the authoritative store) to reconcile same-tab listeners against
    // the value that was actually persisted. Mock the read-back so the
    // local subscriber sees the post-write value.
    vi.mocked(readSharedAuthStorage)
      .mockResolvedValueOnce("next-value")
      .mockResolvedValueOnce(null)
      .mockResolvedValue("ignored");

    const adapter = createSharedAuthStorageAdapter("dot.li");
    const seen: (string | null)[] = [];
    const unsubscribe = adapter.subscribe("SsoSessions", (value) => {
      seen.push(value);
    });

    await adapter.write("SsoSessions", "next-value");
    // Wait for the detached read-back chain scheduled by `.map()` to land
    // its result in the subscriber. Polling on observable state is
    // deterministic across event-loop schedulers. A fixed setTimeout(0)
    // race-loses on slower JS engines.
    await vi.waitFor(() => expect(seen).toContain("next-value"));
    await adapter.clear("SsoSessions");
    await vi.waitFor(() => expect(seen).toContain(null));
    unsubscribe();
    await adapter.write("SsoSessions", "ignored");
    await vi.waitFor(() =>
      expect(writeSharedAuthStorage).toHaveBeenCalledTimes(2),
    );

    expect(writeSharedAuthStorage).toHaveBeenNthCalledWith(
      1,
      "dot.li",
      "SsoSessions",
      "next-value",
    );
    expect(clearSharedAuthStorage).toHaveBeenCalledWith(
      "dot.li",
      "SsoSessions",
    );
    expect(seen).toEqual(["next-value", null]);
  });

  it("subscribes to cross-tab changes via the protocol client", () => {
    const adapter = createSharedAuthStorageAdapter("dot.li");

    // No protocol-level subscription should happen until the adapter's
    // subscribe() is called. We don't want to warm up the host iframe for
    // read-only callers.
    expect(subscribeSharedAuthStorage).not.toHaveBeenCalled();

    adapter.subscribe("SsoSessions", () => {
      /* noop */
    });
    adapter.subscribe("Other", () => {
      /* noop */
    });

    // The adapter should only subscribe to the protocol client once. It
    // multiplexes the single cross-tab listener across all key subscribers.
    expect(subscribeSharedAuthStorage).toHaveBeenCalledTimes(1);
  });

  it("dispatches cross-tab changes to matching in-process subscribers", () => {
    let relay: SharedAuthStorageListener | null = null;
    vi.mocked(subscribeSharedAuthStorage).mockImplementation((listener) => {
      relay = listener;
      return () => {
        relay = null;
      };
    });

    const adapter = createSharedAuthStorageAdapter("dot.li");
    const seen: (string | null)[] = [];
    adapter.subscribe("SsoSessions", (value) => {
      seen.push(value);
    });

    if (relay === null) {
      throw new Error("relay not captured");
    }
    // Simulate a sibling tab writing the same key
    (relay as SharedAuthStorageListener)({
      siteId: "dot.li",
      key: "SsoSessions",
      value: "from-other-tab",
    });

    expect(seen).toEqual(["from-other-tab"]);
  });

  it("ignores cross-tab changes for other siteIds", () => {
    let relay: SharedAuthStorageListener | null = null;
    vi.mocked(subscribeSharedAuthStorage).mockImplementation((listener) => {
      relay = listener;
      return () => {
        relay = null;
      };
    });

    const adapter = createSharedAuthStorageAdapter("dot.li");
    const seen: (string | null)[] = [];
    adapter.subscribe("SsoSessions", (value) => {
      seen.push(value);
    });

    if (relay === null) {
      throw new Error("relay not captured");
    }
    // A broadcast scoped to a different root domain must not fire
    (relay as SharedAuthStorageListener)({
      siteId: "paseo.li",
      key: "SsoSessions",
      value: "leak",
    });

    expect(seen).toEqual([]);
  });
});
