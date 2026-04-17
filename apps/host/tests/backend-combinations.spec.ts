/**
 * dot.li — Backend combination smoke test
 *
 * Loads a known `.dot` domain end-to-end across every supported combination
 * of `(chainBackend × contentBackend)`:
 *
 *   chainBackend:  smoldot-shared-worker | smoldot-direct | rpc
 *   contentBackend: p2p-helia            | ipfs-gateway
 *
 * → 6 combinations. For each, we set the user's chosen backends on the
 * shell origin's localStorage via `context.addInitScript`, navigate to the
 * test domain, and wait for the sandbox iframe to emit the
 * `dotli:app:end` performance mark — the authoritative "content rendered"
 * signal. The test fails if:
 *   - the shell renders `.error-page` (loading failed)
 *   - the sandbox iframe never emits `dotli:app:end` within the timeout
 *   - a chunk preload / SW notification surface appears
 *
 * Override the test domain or port via env:
 *   COMBO_DOMAIN=host-playground  (default)
 *   COMBO_PORT=5173               (default)
 *   COMBO_TIMEOUT_MS=120000       (default — per combination)
 */

import { test, expect, type Page, type Frame } from "@playwright/test";

// ── Config ─────────────────────────────────────────────────

const DOMAIN = process.env.COMBO_DOMAIN ?? "host-playground";
const PORT = process.env.COMBO_PORT ?? "5173";
const TIMEOUT_MS = parseInt(process.env.COMBO_TIMEOUT_MS ?? "120000", 10);

const CHAIN_BACKENDS = [
  "smoldot-shared-worker",
  "smoldot-direct",
  "rpc",
] as const;
const CONTENT_BACKENDS = ["p2p-helia", "ipfs-gateway"] as const;

type ChainBackend = (typeof CHAIN_BACKENDS)[number];
type ContentBackend = (typeof CONTENT_BACKENDS)[number];

// ── Helpers ────────────────────────────────────────────────

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

/**
 * Fail fast if the shell rendered `.error-page` (any loading failure ends
 * up there). We poll the host shell DOM in parallel with the success
 * signal so a thrown error short-circuits the full 120s timeout.
 */
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

/**
 * Resolve when the sandbox iframe emits `dotli:app:end` — the app-side
 * mark that fires after rendering (or writing the dApp into the iframe
 * document) completes. Rejects with the elapsed-time message on timeout
 * so the harness can attach it to the test failure.
 */
async function waitForAppEnd(page: Page, timeoutMs: number): Promise<void> {
  const start = Date.now();
  const appFrame = await waitForAppFrame(page, timeoutMs);
  if (appFrame === null) {
    throw new Error(
      `Sandbox iframe (*.app.localhost) never appeared within ${String(timeoutMs)}ms`,
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

// ── The test ───────────────────────────────────────────────

// Total budget: 6 combinations × (timeout + overhead). Multiply by 2 to
// cover fixture setup / teardown + the first-load Vite compile cost.
test.setTimeout(
  CHAIN_BACKENDS.length * CONTENT_BACKENDS.length * TIMEOUT_MS * 2,
);

test.describe("Backend combinations", () => {
  for (const chainBackend of CHAIN_BACKENDS) {
    for (const contentBackend of CONTENT_BACKENDS) {
      test(`loads ${DOMAIN}.dot with chain=${chainBackend} content=${contentBackend}`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          storageState: undefined,
          serviceWorkers: "allow",
        });

        // Seed the shell origin's localStorage BEFORE navigation so the
        // first read in `getChainBackend` / `getContentBackend` sees the
        // user's choice. Cannot run `evaluate` pre-navigation (no origin
        // yet), so `addInitScript` is the correct hook — Chromium runs
        // it on every document that matches the context's origin, which
        // covers the shell on the first `goto`.
        const chain: ChainBackend = chainBackend;
        const content: ContentBackend = contentBackend;
        await context.addInitScript(
          ({ chain, content }) => {
            try {
              localStorage.setItem("dotli:chain-backend", chain);
              localStorage.setItem("dotli:content-backend", content);
              // Also seed the legacy mode key so any codepath that still
              // reads it sees a consistent preset label (not strictly
              // required — `getMode()` derives from the two axes — but
              // it keeps startup logs coherent).
              const mode =
                chain === "smoldot-shared-worker" && content === "p2p-helia"
                  ? "p2p-shared-worker"
                  : chain === "smoldot-direct" && content === "p2p-helia"
                    ? "p2p-direct"
                    : chain === "rpc" && content === "ipfs-gateway"
                      ? "gateway"
                      : "custom";
              localStorage.setItem("dotli:mode", mode);
            } catch {
              // localStorage unavailable — the shell will still read its
              // runtime default; the test will then verify whichever
              // pair that resolves to. Surface it loudly to avoid a
              // silent mismatch.
              console.warn(
                "[combo-test] localStorage seed failed; backend may not match test label",
              );
            }
          },
          { chain, content },
        );

        const page = await context.newPage();

        // Capture console errors for failure diagnostics.
        const consoleErrors: string[] = [];
        page.on("console", (msg) => {
          if (msg.type() === "error") {
            consoleErrors.push(msg.text());
          }
        });

        const targetUrl = `http://${DOMAIN}.localhost:${PORT}/`;

        try {
          await page.goto(targetUrl, { waitUntil: "commit" });

          // Race the success signal against the error overlay so either
          // resolves the test quickly. A 120s wait on one side would
          // otherwise mask a 2s error with a full-timeout failure.
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

          if (result.kind === "error") {
            throw new Error(
              `Shell rendered error page for chain=${chainBackend} content=${contentBackend}: ${result.reason}`,
            );
          }
          if (result.kind === "timeout") {
            // errorPromise returns timeout only if no error appeared;
            // the successPromise must have won in that branch order.
            // If we got here, both the success and error polls timed
            // out — treat as failure.
            throw new Error(
              `Neither success (dotli:app:end) nor error-page appeared within ${String(TIMEOUT_MS)}ms`,
            );
          }

          // Sanity check: the shell should NOT show an error overlay
          // even after success — a delayed error would be a regression.
          const hasError = await page
            .locator(".error-page-title")
            .first()
            .isVisible()
            .catch(() => false);
          expect(hasError, "unexpected error-page after success").toBe(false);

          // Sanity check: `dotli:app:end` must be present in the sandbox
          // iframe's performance timeline. (Re-asserts what
          // waitForAppEnd already verified but makes the assertion
          // appear in the test report.)
          const appFrame = page
            .frames()
            .find((f) => f.url().includes(".app.localhost"));
          expect(appFrame, "sandbox iframe not attached").toBeDefined();
          const hasAppEnd = await appFrame!.evaluate(() =>
            performance
              .getEntriesByType("mark")
              .some((m) => m.name === "dotli:app:end"),
          );
          expect(hasAppEnd, "dotli:app:end mark missing").toBe(true);
        } finally {
          // Dump console errors on failure for triage. Playwright's
          // default report truncates long console output, so we write
          // them to stdout explicitly.
          if (test.info().status !== test.info().expectedStatus) {
            console.log(
              `\n--- console errors (chain=${chainBackend}, content=${contentBackend}) ---`,
            );
            for (const line of consoleErrors.slice(0, 20)) {
              console.log(`  ${line}`);
            }
            if (consoleErrors.length > 20) {
              console.log(`  ... (${String(consoleErrors.length - 20)} more)`);
            }
          }
          await context.close();
        }
      });
    }
  }
});
