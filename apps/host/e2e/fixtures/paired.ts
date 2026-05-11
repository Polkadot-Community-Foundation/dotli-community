import { test as base, type Page, type Frame } from "@playwright/test";
import { pair, disconnect, generateUsername } from "../helpers/signer-bot";
import { extractQrPayload } from "../helpers/qr";

const SVC_TOKEN = process.env.SIGNER_BOT_SVC_TOKEN ?? "";
const BOT_BASE =
  process.env.SIGNER_BOT_BASE_URL ??
  "https://signing-bot-dev.novasama-tech.org";
const BOT_NETWORK = process.env.SIGNER_BOT_NETWORK ?? "paseo-next";
const PORT = process.env.PORT ?? "5173";
const HOST = process.env.E2E_HOST ?? "host-playground";

/**
 * Worker-scoped fixtures: open a fresh dot.li session, hand its QR
 * deeplink to the Nova signing bot, wait until the host confirms the
 * pairing badge, and locate the host-playground iframe. All tests in the
 * worker share the same paired session — wallet token is one-shot, so we
 * never re-pair within a worker.
 *
 * Per-run username (`dotlitests…`) — see helpers/signer-bot.ts. Each worker
 * gets its own user so on-chain state (allowances, derived product
 * accounts) doesn't leak between runs.
 */
export const test = base.extend<
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- no test-scoped fixtures
  {},
  { pairedPage: Page; productFrame: Frame }
>({
  pairedPage: [
    async ({ browser }, use) => {
      if (!SVC_TOKEN) {
        throw new Error("SIGNER_BOT_SVC_TOKEN not set");
      }
      console.log("[fixture] pairedPage: starting setup");

      const username = generateUsername();
      console.log(`[pair] bot=${BOT_BASE} username=${username}`);

      const ctx = await browser.newContext();
      const page = await ctx.newPage();

      // Capture host page + iframe console logs — invaluable for diagnosing
      // SDK calls that never resolve. Surface warn/error/info lines that
      // mention dotli internals; drop the rest to keep output readable.
      page.on("console", (msg) => {
        const text = msg.text();
        const type = msg.type();
        if (
          type === "error" ||
          type === "warning" ||
          /\[dotli|\[dot\.li|host-papp|statement.store|signing/i.test(text)
        ) {
          // Pairing payloads + statement bodies get full text; everything
          // else is truncated to keep output readable.
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
        // Full stack — TDZ errors and similar are unintelligible without
        // file/line context.
        console.log(`[browser:pageerror] ${err.message}`);
        if (err.stack) {
          console.log(`[browser:pageerror:stack] ${err.stack}`);
        }
      });

      // WebSocket frames — we want to see statement_submit calls going out and
      // any subscription pushes coming back. Filter to method/result lines so
      // we don't flood the log with every chain-head update.
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

      await page.addInitScript(() => {
        try {
          localStorage.setItem("dotli:mode", "gateway");
          localStorage.setItem("dotli:chain-backend", "rpc");
          localStorage.setItem("dotli:content-backend", "ipfs-gateway");
        } catch {
          /* ignore */
        }
      });

      await page.goto(`http://${HOST}.localhost:${PORT}/`, {
        timeout: 120_000,
      });
      await page
        .getByRole("button", { name: "Switch to Gateway" })
        .click({ timeout: 5_000 })
        .catch(() => {});

      const authBtn = page.locator("#auth-button");
      await authBtn.waitFor({ state: "visible", timeout: 30_000 });
      await authBtn.click();

      const qrCanvas = page.locator("#auth-modal-qr canvas");
      await qrCanvas.waitFor({ state: "visible", timeout: 60_000 });

      const deeplink = await extractQrPayload(page, "#auth-modal-qr canvas");
      console.log(`[pair] deeplink (full): ${deeplink}`);

      const pairStart = Date.now();
      const result = await pair(BOT_BASE, SVC_TOKEN, {
        handshake: deeplink,
        username,
        network: BOT_NETWORK,
      });
      console.log(
        `[pair] bot paired in ${Math.round((Date.now() - pairStart) / 1000)}s sessionId=${result.sessionId.slice(0, 16)}…`,
      );

      await page
        .locator("#auth-button .user-badge")
        .waitFor({ state: "visible", timeout: 90_000 });
      console.log(`[pair] authenticated as ${username}`);

      await use(page);

      console.log("[fixture] pairedPage: tearing down");
      await disconnect(BOT_BASE, SVC_TOKEN, result.sessionId);
      await ctx.close();
    },
    { scope: "worker" },
  ],

  productFrame: [
    async ({ pairedPage }, use) => {
      console.log("[fixture] productFrame: locating iframe");
      const start = Date.now();
      let frame: Frame | undefined;
      for (let i = 0; i < 60; i++) {
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
        await pairedPage.waitForTimeout(2_000);
      }
      if (!frame) {
        throw new Error("host-playground iframe never became visible");
      }
      console.log(
        `[pair] iframe ready (${Math.round((Date.now() - start) / 1000)}s)`,
      );
      await use(frame);
    },
    { scope: "worker" },
  ],
});

export { expect } from "@playwright/test";
