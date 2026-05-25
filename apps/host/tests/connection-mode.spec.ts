import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { test } from "./helpers/shared-mode-reset";

const PORT = process.env.COMBO_PORT ?? "5173";
const LANDING_URL = `http://localhost:${PORT}/`;
const FALLBACK_LABEL = "Light client (worker) unavailable";

const BACKENDS = [
  "smoldot-shared-worker",
  "smoldot-direct",
  "rpc-gateway",
] as const;

interface AppliedState {
  chainBackend: string | null;
  url: string;
}

async function readState(page: Page, expected: string): Promise<AppliedState> {
  await page.waitForFunction(
    (e) => localStorage.getItem("dotli:chain-backend") === e,
    expected,
    { timeout: 10_000 },
  );
  return page.evaluate(() => ({
    chainBackend: localStorage.getItem("dotli:chain-backend"),
    url: window.location.href,
  }));
}

async function disableSharedWorker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { SharedWorker?: unknown }).SharedWorker;
  });
}

test.describe("Chain backend × URL persistence", () => {
  for (const backend of BACKENDS) {
    test(`As a user, when I open the app with ?chainBackend=${backend}, the choice is persisted to localStorage`, async ({
      page,
    }) => {
      // When
      await page.goto(`${LANDING_URL}?chainBackend=${backend}`);

      // Then
      const state = await readState(page, backend);
      expect(state.chainBackend).toBe(backend);
    });
  }

  test("As a user, when I open the app with ?chainBackend=foo (unknown), the value is ignored and the default backend is persisted instead", async ({
    page,
  }) => {
    // Given: SharedWorker available → dynamic default is shared-worker.

    // When
    await page.goto(`${LANDING_URL}?chainBackend=foo`);

    // Then: invalid value is dropped, default seeds storage, URL is cleaned.
    const state = await readState(page, "smoldot-shared-worker");
    expect(state.chainBackend).toBe("smoldot-shared-worker");
    expect(state.url).not.toContain("chainBackend=foo");
  });

  test("As a user, when I open the app with a URL chainBackend that differs from my persisted choice, the URL value wins after a wipe+reload", async ({
    page,
  }) => {
    // Given: pre-seed rpc-gateway. `window.name` survives reloads but not
    // new tabs — once-per-test guard against the wipe+reload re-seeding.
    await page.addInitScript(() => {
      if (window.name !== "seeded") {
        localStorage.setItem("dotli:chain-backend", "rpc-gateway");
        window.name = "seeded";
      }
    });

    // When
    await page.goto(`${LANDING_URL}?chainBackend=smoldot-direct`);

    // Then
    const state = await readState(page, "smoldot-direct");
    expect(state.chainBackend).toBe("smoldot-direct");
    expect(state.url).toContain("chainBackend=smoldot-direct");
  });
});

test.describe("Chain backend × SharedWorker availability", () => {
  test("As a user on a SharedWorker-capable browser, opening the app for the first time defaults the backend to smoldot-shared-worker", async ({
    page,
  }) => {
    // When
    await page.goto(LANDING_URL);

    // Then
    const state = await readState(page, "smoldot-shared-worker");
    expect(state.chainBackend).toBe("smoldot-shared-worker");
  });

  test("As a user on a browser without SharedWorker, opening the app for the first time falls back to smoldot-direct", async ({
    page,
  }) => {
    // Given
    await disableSharedWorker(page);

    // When
    await page.goto(LANDING_URL);

    // Then
    const state = await readState(page, "smoldot-direct");
    expect(state.chainBackend).toBe("smoldot-direct");
  });

  test("As a user with a persisted smoldot-shared-worker preference, opening the app in a browser without SharedWorker downgrades the backend to smoldot-direct with a fallback notification", async ({
    page,
  }) => {
    // Given
    await page.addInitScript(() => {
      if (window.name !== "seeded") {
        localStorage.setItem("dotli:chain-backend", "smoldot-shared-worker");
        window.name = "seeded";
      }
      delete (window as unknown as { SharedWorker?: unknown }).SharedWorker;
    });

    // When
    await page.goto(LANDING_URL);

    // Then
    const state = await readState(page, "smoldot-direct");
    expect(state.chainBackend).toBe("smoldot-direct");
    await expect(page.getByText(FALLBACK_LABEL)).toBeVisible();
  });

  test("As a user pasting a ?chainBackend=smoldot-shared-worker URL into a browser without SharedWorker, the URL value is ignored and the fallback notification appears", async ({
    page,
  }) => {
    // Given
    await disableSharedWorker(page);

    // When
    await page.goto(`${LANDING_URL}?chainBackend=smoldot-shared-worker`);

    // Then
    const state = await readState(page, "smoldot-direct");
    expect(state.chainBackend).toBe("smoldot-direct");
    expect(state.url).not.toContain("chainBackend=smoldot-shared-worker");
    await expect(page.getByText(FALLBACK_LABEL)).toBeVisible();
  });

  test("As a user with a persisted smoldot-direct preference, opening the app in a browser without SharedWorker is silent — no fallback notification fires", async ({
    page,
  }) => {
    // Given
    await page.addInitScript(() => {
      localStorage.setItem("dotli:chain-backend", "smoldot-direct");
      delete (window as unknown as { SharedWorker?: unknown }).SharedWorker;
    });

    // When
    await page.goto(LANDING_URL);

    // Then: backend stays as-is; the notification is reserved for the
    // actual downgrade path so we don't cry wolf when nothing changed.
    const state = await readState(page, "smoldot-direct");
    expect(state.chainBackend).toBe("smoldot-direct");
    await expect(page.getByText(FALLBACK_LABEL)).not.toBeVisible();
  });
});

test.describe("Chain backend × URL canonicalisation", () => {
  test("As a user on a SharedWorker-capable browser with the default backend persisted, the URL stays clean", async ({
    page,
  }) => {
    // Given
    await page.addInitScript(() => {
      localStorage.setItem("dotli:chain-backend", "smoldot-shared-worker");
    });

    // When
    await page.goto(LANDING_URL);

    // Then: writeSettingsToSearch elides the dynamic default.
    const state = await readState(page, "smoldot-shared-worker");
    expect(state.url).not.toContain("chainBackend=");
  });

  test("As a user on a browser without SharedWorker with smoldot-direct persisted, the URL stays clean", async ({
    page,
  }) => {
    // Given: dynamic default is `smoldot-direct` for this environment.
    await page.addInitScript(() => {
      localStorage.setItem("dotli:chain-backend", "smoldot-direct");
      delete (window as unknown as { SharedWorker?: unknown }).SharedWorker;
    });

    // When
    await page.goto(LANDING_URL);

    // Then
    const state = await readState(page, "smoldot-direct");
    expect(state.url).not.toContain("chainBackend=");
  });

  test("As a user on a SharedWorker-capable browser with rpc-gateway persisted, the URL is canonicalised to mirror the non-default choice on every visit", async ({
    page,
  }) => {
    // Given
    await page.addInitScript(() => {
      localStorage.setItem("dotli:chain-backend", "rpc-gateway");
    });

    // When: open without any URL params.
    await page.goto(LANDING_URL);

    // Then: a copy-paste of the address bar carries the choice forward.
    const state = await readState(page, "rpc-gateway");
    expect(state.url).toContain("chainBackend=rpc-gateway");
  });
});
