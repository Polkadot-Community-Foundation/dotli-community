import { test as base, type Page, type Frame } from "@playwright/test";
import { existsSync } from "node:fs";
import { STATE_FILE } from "./paths";

const PORT = process.env.PORT ?? "5173";
const HOST = process.env.E2E_HOST ?? "host-playground";

// Restored-session badge wait. The bot was paired once in globalSetup, the
// storageState restores the host's auth on every context, so seeing the
// user-badge should be near-instant. A tight cap surfaces a broken bot or
// host fast instead of running out the workflow clock.
const USER_BADGE_TIMEOUT_MS = 15_000;
const PRODUCT_IFRAME_TIMEOUT_MS = 20_000;

/**
 * Worker-scoped fixtures: open a fresh page that inherits the
 * once-per-run bot pairing via `storageState` written by globalSetup.
 * No QR scan, no bot pair API call here. If the badge doesn't appear
 * inside 15 s the worker fails fast — the bot is either down or the
 * host can't restore auth from the saved state.
 *
 * State sharing: every worker reads the same `.auth/state.json`, so all
 * tests across the run share one bot user. This matches the prior
 * behavior under `workers: 1` (worker-scope pairing) and avoids the
 * re-pair cascade that previously timed out CI on a single test failure.
 */
export const test = base.extend<
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- no test-scoped fixtures
  {},
  { pairedPage: Page; productFrame: Frame }
>({
  pairedPage: [
    async ({ browser }, use) => {
      if (!existsSync(STATE_FILE)) {
        throw new Error(
          `pairedPage: ${STATE_FILE} missing — globalSetup must run first. ` +
            `If you ran the test directly, ensure SIGNER_BOT_SVC_TOKEN is set ` +
            `and re-run via \`bun run test:e2e\`.`,
        );
      }

      const ctx = await browser.newContext({ storageState: STATE_FILE });
      const page = await ctx.newPage();

      // Surface host + iframe console noise filtered to dotli internals so
      // we can diagnose SDK calls that never resolve without flooding logs.
      page.on("console", (msg) => {
        const text = msg.text();
        const type = msg.type();
        if (
          type === "error" ||
          type === "warning" ||
          /\[dotli|\[dot\.li|host-papp|statement.store|signing/i.test(text)
        ) {
          const isFullText =
            type === "error" ||
            text.includes("polkadotapp://") ||
            text.includes("dot.li signing") ||
            text.includes("session info");
          const out = isFullText ? text : text.slice(0, 400);
          console.log(`[browser:${type}] ${out}`);
        }
      });
      page.on("pageerror", (err) => {
        console.log(`[browser:pageerror] ${err.message}`);
        if (err.stack) {
          console.log(`[browser:pageerror:stack] ${err.stack}`);
        }
      });

      // Mirror the init flags globalSetup used so the page boots into the
      // same backend mode and the restored localStorage stays consistent.
      await page.addInitScript(() => {
        try {
          localStorage.setItem("dotli:mode", "gateway");
          localStorage.setItem("dotli:chain-backend", "rpc");
          localStorage.setItem("dotli:content-backend", "ipfs-gateway");
        } catch {
          /* ignore */
        }
      });

      // WebSocket frames — statement_submit / broadcast traffic for
      // diagnosing the signing tests. Filtered to avoid chain-head spam.
      try {
        const cdp = await ctx.newCDPSession(page);
        await cdp.send("Network.enable");
        cdp.on("Network.webSocketFrameSent", (e) => {
          const text = e.response.payloadData;
          if (/statement_submit|statement_store|broadcast/i.test(text)) {
            console.log(`[ws→] ${text.slice(0, 500)}`);
          }
        });
        cdp.on("Network.webSocketFrameReceived", (e) => {
          const text = e.response.payloadData;
          if (
            /statement_submit|statement_store|"error"|broadcast/i.test(text)
          ) {
            console.log(`[ws←] ${text.slice(0, 500)}`);
          }
        });
      } catch (e) {
        console.log(`[ws] CDP attach failed: ${(e as Error).message}`);
      }

      await page.goto(`http://${HOST}.localhost:${PORT}/`, {
        timeout: 60_000,
      });
      await page
        .getByRole("button", { name: "Switch to Gateway" })
        .click({ timeout: 5_000 })
        .catch(() => {});

      const restoreStart = Date.now();
      await page
        .locator("#auth-button .user-badge")
        .waitFor({ state: "visible", timeout: USER_BADGE_TIMEOUT_MS });
      console.log(
        `[pairedPage] session restored in ${Date.now() - restoreStart}ms`,
      );

      await use(page);

      await ctx.close();
    },
    { scope: "worker" },
  ],

  productFrame: [
    async ({ pairedPage }, use) => {
      const start = Date.now();
      let frame: Frame | undefined;
      // Iframe attach + first paint usually lands within a few seconds of
      // the user-badge. Bounded loop instead of a single waitFor so we can
      // probe multiple frames as they mount.
      while (Date.now() - start < PRODUCT_IFRAME_TIMEOUT_MS) {
        for (const f of pairedPage.frames()) {
          if (f === pairedPage.mainFrame()) continue;
          const ok = await f
            .locator('h1:has-text("Host Playground")')
            .first()
            .isVisible({ timeout: 500 })
            .catch(() => false);
          if (ok) {
            frame = f;
            break;
          }
        }
        if (frame) break;
        await pairedPage.waitForTimeout(500);
      }
      if (!frame) {
        throw new Error(
          `host-playground iframe not visible within ${PRODUCT_IFRAME_TIMEOUT_MS}ms`,
        );
      }
      console.log(`[productFrame] iframe ready in ${Date.now() - start}ms`);
      await use(frame);
    },
    { scope: "worker" },
  ],
});

export { expect } from "@playwright/test";
