/**
 * Host cache settings.
 *
 * `skipWorkerCache` is not covered. The flag only triggers the IDB
 * purge sweep in `apps/protocol/src/main.ts`, and the protocol-origin
 * IDB it would target (`dotli` with a `chains` store, pre-opened in
 * `apps/protocol/index.html`) is empty in practice: smoldot does not
 * auto-persist (requires `chainHead_unstable_finalizedDatabase` JSON-
 * RPC, which dotli does not call), polkadot-api uses no IDB, and the
 * `chains` store has no writers.
 *
 * The cross-tab speedup that does exist comes from the SharedWorker's
 * in-memory state (`smoldot-shared-worker` mode only), which lives in
 * RAM as long as at least one tab is open; `skipWorkerCache` does not
 * touch it. Coverage of this flag is deferred until snapshot
 * persistence is wired up and the keep-set is narrowed to clear just
 * the `chains` store rather than treating the whole `dotli` DB as one
 * keep/purge unit.
 *
 * Env overrides: DOMAIN, PORT, TIMEOUT_MS
 */

import { expect } from "@playwright/test";
import { DOMAIN, PORT, TIMEOUT_MS } from "./helpers/env";
import { setupTest } from "./helpers/context";
import { waitForResolutionOutcome } from "./helpers/product-frame";
import {
  hasCachedCid,
  hostResolveStarted,
  sandboxArchiveCacheLookups,
  trackArchiveCacheLookups,
  waitForCachedCid,
} from "./helpers/cache";
import {
  BACKENDS,
  CACHE_ENABLED,
  SKIP_ARCHIVE_ONLY,
  SKIP_CID_ONLY,
  updateCacheSettings,
} from "./fixtures/settings";
import { test } from "./helpers/shared-mode-reset";

const BASE_URL = `http://${DOMAIN}.localhost:${PORT}/`;

test.setTimeout(BACKENDS.length * TIMEOUT_MS * 4);

test.describe("Cache settings", () => {
  for (const backend of BACKENDS) {
    test(`As a user with the CID cache enabled via ${backend}, the shell serves the CID from cache on revisit`, async ({
      browser,
    }) => {
      // Given
      const { context, page } = await setupTest(browser, {
        backend,
        cacheSeed: CACHE_ENABLED,
      });
      await page.goto(BASE_URL, { waitUntil: "commit" });
      await waitForResolutionOutcome(page, TIMEOUT_MS, backend);
      expect(await hostResolveStarted(page)).toBe(true);
      await waitForCachedCid(page, DOMAIN, 5_000);

      try {
        // When
        await page.reload({ waitUntil: "commit" });

        // Then
        await waitForResolutionOutcome(page, TIMEOUT_MS, backend);
        expect(await hostResolveStarted(page)).toBe(false);
      } finally {
        await context.close();
      }
    });

    test(`As a user with the CID cache disabled via ${backend}, the shell re-resolves on every visit`, async ({
      browser,
    }) => {
      // Given
      const { context, page } = await setupTest(browser, {
        backend,
        cacheSeed: CACHE_ENABLED,
      });
      await page.goto(BASE_URL, { waitUntil: "commit" });
      await waitForResolutionOutcome(page, TIMEOUT_MS, backend);
      await waitForCachedCid(page, DOMAIN, 5_000);

      try {
        // When
        await updateCacheSettings(page, SKIP_CID_ONLY);
        await page.goto(BASE_URL, { waitUntil: "commit" });

        // Then
        await waitForResolutionOutcome(page, TIMEOUT_MS, backend);
        expect(await hostResolveStarted(page)).toBe(true);
        expect(await hasCachedCid(page, DOMAIN)).toBe(true);
      } finally {
        await context.close();
      }
    });
  }

  for (const backend of BACKENDS) {
    test(`As a user with the archive cache enabled via ${backend}, the sandbox consults the SW archive cache on every visit`, async ({
      browser,
    }) => {
      // Given
      const { context, page } = await setupTest(browser, {
        backend,
        cacheSeed: CACHE_ENABLED,
      });
      await trackArchiveCacheLookups(context);
      await page.goto(BASE_URL, { waitUntil: "commit" });
      await waitForResolutionOutcome(page, TIMEOUT_MS, backend);

      try {
        // When
        await page.reload({ waitUntil: "commit" });

        // Then
        await waitForResolutionOutcome(page, TIMEOUT_MS, backend);
        expect(await sandboxArchiveCacheLookups(page)).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    });

    test(`As a user with the archive cache disabled via ${backend}, the sandbox skips the SW archive cache lookup`, async ({
      browser,
    }) => {
      // Given
      const { context, page } = await setupTest(browser, {
        backend,
        cacheSeed: SKIP_ARCHIVE_ONLY,
      });
      await trackArchiveCacheLookups(context);

      try {
        // When
        await page.goto(BASE_URL, { waitUntil: "commit" });

        // Then
        await waitForResolutionOutcome(page, TIMEOUT_MS, backend);
        expect(await sandboxArchiveCacheLookups(page)).toBe(0);
      } finally {
        await context.close();
      }
    });
  }
});
