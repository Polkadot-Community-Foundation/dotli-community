import { test, expect } from "@playwright/test";
import { TIMEOUTS } from "@dotli/config/timeouts";

const DOMAIN = process.env.COMBO_DOMAIN ?? "host-playground";
const PORT = process.env.COMBO_PORT ?? "5173";

test("As a user, when loading times out I see an error and can switch backend in one click", async ({
  page,
  context,
}) => {
  // Given
  await page.addInitScript(() => {
    if (localStorage.getItem("dotli:chain-backend") === null) {
      localStorage.setItem("dotli:chain-backend", "smoldot-direct");
      localStorage.setItem("dotli:content-backend", "ipfs-gateway");
    }
  });
  await page.addInitScript((targetMs: number) => {
    const orig = window.setTimeout.bind(window);
    window.setTimeout = ((
      handler: TimerHandler,
      ms?: number,
      ...rest: unknown[]
    ) =>
      orig(
        handler,
        ms === targetMs ? 3_000 : ms,
        ...rest,
      )) as typeof window.setTimeout;
  }, TIMEOUTS.ASSET_HUB_FINALIZED_SYNC);

  // When
  await page.goto(`http://${DOMAIN}.localhost:${PORT}/`, {
    waitUntil: "domcontentloaded",
  });
  await context.setOffline(true);

  // Then
  await expect(page.locator(".error-page-title")).toHaveText(
    "Something went wrong",
    { timeout: 15_000 },
  );
  await expect(page.locator(".error-page-detail")).toHaveCount(0);
  const fallbackBtn = page.locator("#error-retry-btn");
  await expect(fallbackBtn).toContainText(
    "Try with RPC Node (trusted provider)",
  );
  await context.setOffline(false);
  await fallbackBtn.click();
  await page.waitForLoadState("domcontentloaded");
  const stored = await page.evaluate(() =>
    localStorage.getItem("dotli:chain-backend"),
  );
  expect(stored).toBe("rpc");
});

test("As a user, when the app resolution crashes I see an error and can switch backend", async ({
  page,
}) => {
  // Given
  await page.addInitScript(() => {
    localStorage.setItem("dotli:chain-backend", "smoldot-direct");
    localStorage.setItem("dotli:content-backend", "ipfs-gateway");
  });

  // Mock the protocol iframe: signal ready instantly, then crash (fatal) when
  // the resolveDotName request arrives — simulating a smoldot panic mid-resolution.
  await page.route("**", async (route) => {
    const isProtocolDoc =
      route.request().url().includes(`host.localhost:${PORT}`) &&
      route.request().resourceType() === "document";
    if (!isProtocolDoc) {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: `<!DOCTYPE html><html><body><script>
        window.parent.postMessage(
          { namespace: "dotli:protocol", kind: "ready" },
          "*"
        );
        window.addEventListener("message", function (e) {
          if (
            e.data &&
            e.data.namespace === "dotli:protocol" &&
            e.data.method === "resolveDotName"
          ) {
            window.parent.postMessage(
              { namespace: "dotli:protocol", kind: "fatal", message: "smoldot panic" },
              "*"
            );
          }
        });
      </script></body></html>`,
    });
  });

  // When
  await page.goto(`http://${DOMAIN}.localhost:${PORT}/`, {
    waitUntil: "domcontentloaded",
  });

  // Then
  await expect(page.locator(".error-page-title")).toHaveText(
    "Something went wrong",
    { timeout: 10_000 },
  );
  await expect(page.locator("#error-retry-btn")).toContainText(
    "Try with RPC Node (trusted provider)",
  );
});

test("As a user, after a resolution timeout, switching backend automatically retries the load", async ({
  page,
  context,
}) => {
  // Given
  await page.addInitScript(() => {
    if (localStorage.getItem("dotli:chain-backend") === null) {
      localStorage.setItem("dotli:chain-backend", "smoldot-direct");
      localStorage.setItem("dotli:content-backend", "ipfs-gateway");
    }
  });
  await page.addInitScript((targetMs: number) => {
    const orig = window.setTimeout.bind(window);
    window.setTimeout = ((
      handler: TimerHandler,
      ms?: number,
      ...rest: unknown[]
    ) =>
      orig(
        handler,
        ms === targetMs ? 3_000 : ms,
        ...rest,
      )) as typeof window.setTimeout;
  }, TIMEOUTS.ASSET_HUB_FINALIZED_SYNC);
  await page.goto(`http://${DOMAIN}.localhost:${PORT}/`, {
    waitUntil: "domcontentloaded",
  });
  await context.setOffline(true);
  await expect(page.locator(".error-page-title")).toHaveText(
    "Something went wrong",
    { timeout: 15_000 },
  );
  const backendBefore = await page.evaluate(() =>
    localStorage.getItem("dotli:chain-backend"),
  );
  expect(backendBefore).toBe("smoldot-direct");

  // When
  await context.setOffline(false);
  await page.locator("#error-retry-btn").click();
  await page.waitForLoadState("domcontentloaded");

  // Then
  const backendAfter = await page.evaluate(() =>
    localStorage.getItem("dotli:chain-backend"),
  );
  expect(backendAfter).toBe("rpc");
  await expect(page.locator(".error-page-title")).toHaveCount(0);
});
