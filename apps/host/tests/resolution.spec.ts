/**
 * End-to-end resolution tests across all supported backend combinations.
 *
 * Env overrides: COMBO_DOMAIN, COMBO_PORT, COMBO_TIMEOUT_MS
 */

import { test, expect, type Page, type Frame } from "@playwright/test";
import {
  IFRAME_FORWARDER,
  SHARED_WORKER_FORWARDER,
  WORKER_FORWARDER,
} from "./helpers/iframe-logs-forwarder";

const DOMAIN = process.env.COMBO_DOMAIN ?? "host-playground";
const PORT = process.env.COMBO_PORT ?? "5173";
const TIMEOUT_MS = parseInt(process.env.COMBO_TIMEOUT_MS ?? "45000", 10);

const CHAIN_BACKENDS = [
  "smoldot-shared-worker",
  "smoldot-direct",
  "rpc",
] as const;
const CONTENT_BACKENDS = ["p2p-helia", "ipfs-gateway"] as const;

type ChainBackend = (typeof CHAIN_BACKENDS)[number];
type ContentBackend = (typeof CONTENT_BACKENDS)[number];

function modeFor(chain: ChainBackend, content: ContentBackend): string {
  if (chain === "smoldot-shared-worker" && content === "p2p-helia") {
    return "p2p-shared-worker";
  }
  if (chain === "smoldot-direct" && content === "p2p-helia") {
    return "p2p-direct";
  }
  if (chain === "rpc" && content === "ipfs-gateway") {
    return "gateway";
  }
  return "custom";
}

async function waitForAppFrame(
  page: Page,
  timeoutMs: number,
): Promise<Frame | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frames().find((f) => f.url().includes(".app.localhost"));
    if (frame !== undefined) {
      return frame;
    }
    await page.waitForTimeout(200);
  }
  return null;
}

async function waitForErrorPage(
  page: Page,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const title = await page
      .locator(".error-page-title")
      .first()
      .textContent({ timeout: 500 })
      .catch(() => null);
    if (title !== null && title.length > 0) {
      const detail = await page
        .locator(".error-page-detail")
        .first()
        .textContent({ timeout: 500 })
        .catch(() => "");
      return `${title}: ${detail ?? ""}`;
    }
    await page.waitForTimeout(250);
  }
  return "";
}

async function waitForAppEnd(page: Page, timeoutMs: number): Promise<void> {
  const start = Date.now();
  const appFrame = await waitForAppFrame(page, timeoutMs);
  if (appFrame === null) {
    throw new Error(
      `Sandbox iframe never appeared within ${String(timeoutMs)}ms`,
    );
  }
  const remaining = Math.max(1000, timeoutMs - (Date.now() - start));
  await appFrame.waitForFunction(
    () =>
      performance
        .getEntriesByType("mark")
        .some((m) => m.name === "dotli:app:end"),
    { timeout: remaining, polling: 500 },
  );
}

const TOTAL_TESTS = CHAIN_BACKENDS.length * CONTENT_BACKENDS.length;
test.setTimeout(TOTAL_TESTS * TIMEOUT_MS * 2);

test.describe("Resolution with different backend settings", () => {
  for (const chainBackend of CHAIN_BACKENDS) {
    for (const contentBackend of CONTENT_BACKENDS) {
      test(`resolves ${DOMAIN}.dot chain=${chainBackend} content=${contentBackend}`, async ({
        browser,
      }) => {
        // Given
        const context = await browser.newContext({
          storageState: undefined,
          serviceWorkers: "allow",
        });

        await context.addInitScript(
          ({ chain, content, mode }) => {
            try {
              localStorage.setItem("dotli:chain-backend", chain);
              localStorage.setItem("dotli:content-backend", content);
              localStorage.setItem("dotli:mode", mode);
            } catch (err) {
              console.warn("[resolution-test] localStorage seed failed", err);
            }
          },
          {
            chain: chainBackend,
            content: contentBackend,
            mode: modeFor(chainBackend, contentBackend),
          },
        );

        await context.route("**", async (route) => {
          const req = route.request();
          if (req.resourceType() !== "document") {
            await route.continue();
            return;
          }
          process.stdout.write(`[route:doc] ${req.url()}\n`);
          try {
            const response = await route.fetch();
            const ct = (response.headers()["content-type"] || "").toLowerCase();
            const body = await response.text();
            const injected = body.replace(
              /<head(\s[^>]*)?>/i,
              (m) => `${m}${IFRAME_FORWARDER}`,
            );
            const finalBody =
              body.length > 0 && injected !== body
                ? injected
                : IFRAME_FORWARDER + body;
            await route.fulfill({
              response,
              body: finalBody,
              headers: { ...response.headers(), "content-type": "text/html" },
            });
            process.stdout.write(
              `[route:doc:done] ${req.url()} ct=${ct || "(none)"} injected=${finalBody !== body}\n`,
            );
          } catch (err) {
            process.stdout.write(
              `[route:doc:err] ${req.url()} ${err instanceof Error ? err.message : String(err)}\n`,
            );
            await route.continue();
          }
        });
        await context.route("**/*smoldot_worker*.js", async (route) => {
          try {
            const response = await route.fetch();
            const body = await response.text();
            await route.fulfill({
              response,
              body: WORKER_FORWARDER + body,
              headers: {
                ...response.headers(),
                "content-type": "application/javascript",
              },
            });
          } catch {
            await route.continue();
          }
        });

        await context.route("**/protocol-shared-worker-*.js", async (route) => {
          const response = await route.fetch();
          const body = await response.text();
          await route.fulfill({
            body: SHARED_WORKER_FORWARDER + body,
            contentType: "application/javascript",
          });
        });

        await context.addInitScript(() => {
          const OrigSW = window.SharedWorker;
          // @ts-expect-error — replacing global constructor
          window.SharedWorker = function (
            url: string,
            opts?: WorkerOptions | string,
          ) {
            const sw = new OrigSW(url, opts);
            sw.port.addEventListener(
              "message",
              (e: MessageEvent<{ __pw_sw_log__?: boolean; text?: string }>) => {
                if (e.data.__pw_sw_log__ === true) {
                  console.warn(`[SW] ${e.data.text ?? ""}`);
                }
              },
            );
            return sw;
          };
        });

        const page = await context.newPage();
        const consoleErrors: string[] = [];
        page.on("console", (msg) => {
          if (msg.type() === "error") {
            consoleErrors.push(msg.text());
          }
          const text = msg.text();
          if (text.startsWith("[FRAMELOG]")) {
            console.log(text);
          } else if (msg.type() === "error") {
            console.log(`[raw:error] ${text}`);
          }
        });

        try {
          // When
          await page.goto(`http://${DOMAIN}.localhost:${PORT}/`, {
            waitUntil: "commit",
          });

          const successPromise = waitForAppEnd(page, TIMEOUT_MS).then(() => ({
            kind: "ok" as const,
          }));
          const errorPromise = waitForErrorPage(page, TIMEOUT_MS).then(
            (reason) =>
              reason.length > 0
                ? { kind: "error" as const, reason }
                : { kind: "timeout" as const },
          );
          const result = await Promise.race([successPromise, errorPromise]);

          // Then
          if (result.kind === "error") {
            throw new Error(
              `Shell rendered error page for chain=${chainBackend} content=${contentBackend}: ${result.reason}`,
            );
          }
          if (result.kind === "timeout") {
            throw new Error(
              `Neither success nor error-page appeared within ${String(TIMEOUT_MS)}ms`,
            );
          }

          const hasError = await page
            .locator(".error-page-title")
            .first()
            .isVisible()
            .catch(() => false);
          expect(hasError, "unexpected error-page after success").toBe(false);

          const appFrame = page
            .frames()
            .find((f) => f.url().includes(".app.localhost"));
          expect(appFrame, "sandbox iframe not attached").toBeDefined();
          if (appFrame === undefined) {
            throw new Error("sandbox iframe not attached");
          }
          const hasAppEnd = await appFrame.evaluate(() =>
            performance
              .getEntriesByType("mark")
              .some((m) => m.name === "dotli:app:end"),
          );
          expect(hasAppEnd, "dotli:app:end mark missing").toBe(true);
        } finally {
          if (consoleErrors.length > 0) {
            console.log(
              `\n--- console errors (chain=${chainBackend}, content=${contentBackend}) ---`,
            );
            for (const line of consoleErrors.slice(0, 20)) {
              console.log(`  ${line}`);
            }
          }
          await context.close();
        }
      });
    }
  }
});
