/**
 * Auth statement-subscription smoke test.
 *
 * Seeds the chain backend, loads the host with `?initAuthSubscribe=1` to install
 * `window.__dotliAuthSubscribe`, then calls `subscribeAll([], TIMEOUT)` and expects at
 * least one statement back. `matchAll: []` is the "match-everything" filter
 * (vacuous truth, every statement satisfies the empty conjunction).
 *
 * Pinned to `rpc-gateway`. This is a pipeline smoke test, not a smoldot
 * cold-sync test. The smoldot variants take ~240s each and add no signal
 * beyond what `loading` and `resolution` already cover.
 */

import { expect } from "@playwright/test";
import { test } from "./helpers/shared-mode-reset";
import { seedBackend } from "./fixtures/settings";

interface SubscribeResult {
  count: number;
  isComplete: boolean;
}

interface AuthSubscribeApi {
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
    __dotliAuthSubscribe?: AuthSubscribeApi;
  }
}

const PORT = process.env.COMBO_PORT ?? "5173";
const HOST_URL = `http://e2e-ss.localhost:${PORT}/?initAuthSubscribe=1`;
const SUBSCRIBE_TIMEOUT_MS = 30_000;

test(`As a product subscribing via __dotliAuthSubscribe.subscribeAll([], ${String(SUBSCRIBE_TIMEOUT_MS)}ms), I receive at least one statement back over rpc-gateway`, async ({
  page,
}) => {
  test.setTimeout(SUBSCRIBE_TIMEOUT_MS + 30_000);

  page.on("console", (msg) => {
    const text = msg.text();
    if (
      msg.type() === "error" ||
      msg.type() === "warning" ||
      text.includes("[dotli ss]") ||
      text.includes("[dot.li auth]") ||
      text.includes("[dot.li auth-subscribe]")
    ) {
      // eslint-disable-next-line no-console
      console.log(`[${msg.type()}] ${text}`);
    }
  });

  // Given
  await seedBackend(page, "rpc-gateway");
  await page.goto(HOST_URL, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle("dotli-auth-subscribe-ready", {
    timeout: 30_000,
  });

  // When
  const result = await page.evaluate(async (timeoutMs) => {
    if (!window.__dotliAuthSubscribe) {
      throw new Error("__dotliAuthSubscribe not installed");
    }
    return window.__dotliAuthSubscribe.subscribeAll([], timeoutMs);
  }, SUBSCRIBE_TIMEOUT_MS);

  // Then
  expect(
    result.count,
    `expected >=1 statement via subscribeStatements(matchAll: []) within ${String(SUBSCRIBE_TIMEOUT_MS)}ms (backend: rpc-gateway)`,
  ).toBeGreaterThan(0);
});
