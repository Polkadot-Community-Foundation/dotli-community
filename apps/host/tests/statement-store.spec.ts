import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// E2E coverage for the auth statement-store path. Each test seeds
// `dotli:chain-backend`, navigates to the host with `?e2e_init_auth=1`
// to install `window.__dotliE2E`, then calls `subscribeAll([], TIMEOUT)`
// and expects to receive at least one statement.
//
// `matchAll: []` is the "match-everything" filter (vacuous truth — every
// statement satisfies the empty conjunction).

type Backend = "smoldot-direct" | "smoldot-shared-worker" | "rpc-gateway";

interface SubscribeResult {
  count: number;
  isComplete: boolean;
}

interface DotliE2EApi {
  backend: string;
  subscribeAll: (
    topicsHex: string[],
    timeoutMs: number,
  ) => Promise<SubscribeResult>;
  subscribeAny: (
    topicsHex: string[],
    timeoutMs: number,
  ) => Promise<SubscribeResult>;
}

declare global {
  interface Window {
    __dotliE2E?: DotliE2EApi;
  }
}

const PORT = process.env.COMBO_PORT ?? "5173";
const HOST_URL = `http://e2e-ss.localhost:${PORT}/?e2e_init_auth=1`;

// RPC first (cheapest path, no smoldot warm-up), then smoldot variants.
const BACKENDS: Backend[] = [
  "rpc-gateway",
  "smoldot-direct",
  "smoldot-shared-worker",
];

// RPC-gateway is fast; smoldot needs to fetch chain spec, sync People
// Paseo, and only then start receiving statements. Be generous.
function timeoutFor(backend: Backend): number {
  return backend === "rpc-gateway" ? 30_000 : 240_000;
}

async function seedBackend(page: Page, backend: Backend): Promise<void> {
  await page.addInitScript((backend) => {
    localStorage.setItem("dotli:chain-backend", backend);
  }, backend);
}

for (const backend of BACKENDS) {
  test(`Statement Store: backend=${backend}`, async ({ page }) => {
    test.setTimeout(timeoutFor(backend) + 30_000);

    page.on("console", (msg) => {
      const text = msg.text();
      // Drop the chatty smoldot trace noise; surface warnings/errors
      // and explicit dotli logs only.
      if (
        msg.type() === "error" ||
        msg.type() === "warning" ||
        text.includes("[dotli ss]") ||
        text.includes("[dot.li auth]") ||
        text.includes("[dot.li e2e]")
      ) {
        // eslint-disable-next-line no-console
        console.log(`[${msg.type()}] ${text}`);
      }
    });

    await seedBackend(page, backend);

    await page.goto(HOST_URL, { waitUntil: "domcontentloaded" });

    // Hook installs `window.__dotliE2E` and renames the document title
    // once auth + statement store are wired.
    await expect(page).toHaveTitle("dotli-e2e-ready", {
      timeout: 30_000,
    });

    const result = await page.evaluate(async (timeoutMs) => {
      if (!window.__dotliE2E) {
        throw new Error("__dotliE2E not installed");
      }
      return window.__dotliE2E.subscribeAll([], timeoutMs);
    }, timeoutFor(backend));

    expect(
      result.count,
      `expected ≥1 statement via subscribeStatements(matchAll: []) within ${String(timeoutFor(backend))}ms (backend: ${backend})`,
    ).toBeGreaterThan(0);
  });
}
