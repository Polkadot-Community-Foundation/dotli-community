// Integration tests for the URL settings + shared-mode bootstrap combo.
//
// We're verifying that, after the rebase that brought PR #420 (URL params)
// onto the persist-options branch:
//   1. A URL param takes precedence over a prior persisted localStorage
//      choice, and the change wipes + reloads so the page boots clean.
//   2. A fresh subdomain seeded only from the URL ends up with the chosen
//      value persisted to localStorage.
//   3. The host canonicalises the URL on every load to mirror the effective
//      state (non-default axes get re-inserted into the URL).
//
// Assertions stay on per-page state (localStorage, URL) — the cross-subdomain
// HTTP mirror is process-wide, so asserting on it would race against any
// sibling Playwright worker. The mirror itself is exercised by the bootstrap
// path; here we focus on the user-visible per-subdomain behaviour.

import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { test } from "./helpers/shared-mode-reset";

const PORT = process.env.COMBO_PORT ?? "5173";

// `localhost` (no subdomain) hits the landing-page branch — main() runs the
// applyUrlSettings + bootstrap path and returns before any chain resolution.
const LANDING_URL = `http://localhost:${PORT}/`;

interface AppliedState {
  chainBackend: string | null;
  cacheSettings: string | null;
  network: string | null;
  url: string;
}

/**
 * Wait for main()'s applyUrlSettings to settle: poll until
 * `dotli:chain-backend` equals the expected value (covers the wipe+reload
 * branch where the page may reload itself mid-flight). Then snapshot.
 */
async function readState(
  page: Page,
  expectedChainBackend: string,
): Promise<AppliedState> {
  await page.waitForFunction(
    (expected) => localStorage.getItem("dotli:chain-backend") === expected,
    expectedChainBackend,
    { timeout: 10_000 },
  );
  return page.evaluate(() => ({
    chainBackend: localStorage.getItem("dotli:chain-backend"),
    cacheSettings: localStorage.getItem("dotli:cache-settings"),
    network: localStorage.getItem("dotli:network"),
    url: window.location.href,
  }));
}

test.describe("URL settings × shared-mode bootstrap", () => {
  test("URL chainBackend on a fresh subdomain persists to localStorage", async ({
    page,
  }) => {
    // Given: fresh subdomain (no localStorage), shared store wiped by the
    // auto fixture, URL specifies rpc-gateway.
    // When
    await page.goto(`${LANDING_URL}?chainBackend=rpc-gateway`);

    // Then
    const state = await readState(page, "rpc-gateway");
    expect(state.chainBackend).toBe("rpc-gateway");
    expect(state.url).toContain("chainBackend=rpc-gateway");
  });

  test("URL chainBackend overrides a prior persisted localStorage choice via wipe + reload", async ({
    page,
  }) => {
    // Given: pre-seed localStorage with smoldot-shared-worker. `window.name`
    // survives reloads but not new tabs, so we use it as a once-per-test
    // guard to keep `applyUrlSettings`'s wipe+reload from looping back to
    // the seed.
    await page.addInitScript(() => {
      if (window.name !== "seeded") {
        localStorage.setItem("dotli:chain-backend", "smoldot-shared-worker");
        localStorage.setItem("dotli:network", "paseo-next-v1");
        window.name = "seeded";
      }
    });

    // When: open the URL with a different chainBackend.
    await page.goto(`${LANDING_URL}?chainBackend=rpc-gateway`);

    // Then: after the wipe + reload, the URL value is the persisted one.
    const state = await readState(page, "rpc-gateway");
    expect(state.chainBackend).toBe("rpc-gateway");
    expect(state.url).toContain("chainBackend=rpc-gateway");
  });

  test("URL gets canonicalised to mirror effective state on a no-op visit", async ({
    page,
  }) => {
    // Given: pre-seed localStorage with rpc-gateway.
    await page.addInitScript(() => {
      localStorage.setItem("dotli:chain-backend", "rpc-gateway");
    });

    // When: open without any URL params.
    await page.goto(LANDING_URL);

    // Then: applyUrlSettings re-inserts chainBackend (non-default axis)
    // into the URL so a copy-paste of the address bar carries the choice.
    const state = await readState(page, "rpc-gateway");
    expect(state.chainBackend).toBe("rpc-gateway");
    expect(state.url).toContain("chainBackend=rpc-gateway");
  });

  test("default values stay out of the URL after persistency", async ({
    page,
  }) => {
    // Given: pre-seed localStorage with the default backend.
    await page.addInitScript(() => {
      localStorage.setItem("dotli:chain-backend", "smoldot-direct");
    });

    // When: open without URL params.
    await page.goto(LANDING_URL);

    // Then: the URL stays clean — defaults never appear.
    const state = await readState(page, "smoldot-direct");
    expect(state.chainBackend).toBe("smoldot-direct");
    expect(state.url).not.toContain("chainBackend");
  });

  test("after a URL-driven set, a plain reload without URL params keeps the chosen backend", async ({
    page,
  }) => {
    // Given: fresh page, URL seeds rpc-gateway.
    await page.goto(`${LANDING_URL}?chainBackend=rpc-gateway`);
    await readState(page, "rpc-gateway");

    // When: drop the URL param and reload.
    await page.goto(LANDING_URL);

    // Then: localStorage still has the choice; the URL gets canonicalised
    // back so a copy-paste carries it forward.
    const state = await readState(page, "rpc-gateway");
    expect(state.chainBackend).toBe("rpc-gateway");
    expect(state.url).toContain("chainBackend=rpc-gateway");
  });

  test("URL cache flags persist alongside chainBackend", async ({ page }) => {
    // When
    await page.goto(
      `${LANDING_URL}?chainBackend=rpc-gateway&skipCidCache=0&skipArchiveCache=0&skipWorkerCache=0`,
    );

    // Then
    const state = await readState(page, "rpc-gateway");
    expect(state.chainBackend).toBe("rpc-gateway");
    expect(state.cacheSettings).not.toBeNull();
    const cache = JSON.parse(state.cacheSettings ?? "{}") as Record<
      string,
      unknown
    >;
    expect(cache.skipCidCache).toBe(false);
    expect(cache.skipArchiveCache).toBe(false);
    expect(cache.skipWorkerCache).toBe(false);
    expect(state.url).toContain("skipCidCache=0");
    expect(state.url).toContain("skipArchiveCache=0");
    expect(state.url).toContain("skipWorkerCache=0");
  });
});
