/**
 * Test helpers for probing the product Frame inside the sandbox iframe.
 *
 * The sandbox bootstrap calls `document.write` to swap the document with
 * the product HTML. Window/Frame identity is preserved across that swap,
 * so the same Frame returned by Playwright once `dotli:app:end` fires is
 * the product Frame we read `window.location` from.
 */

import { expect, type Frame, type Page } from "@playwright/test";
import { SANDBOX_CONTRACT_PARAMS } from "@dotli/config/host-sandbox-contract";

export interface ProductLocation {
  pathname: string;
  search: string;
  hash: string;
  href: string;
}

/**
 * Wait for the sandbox iframe to attach AND finish `document.write` so the
 * product's URL is the one the test should observe.
 */
export async function getProductFrame(
  page: Page,
  timeoutMs: number,
): Promise<Frame> {
  const start = Date.now();
  let frame: Frame | undefined;
  while (Date.now() - start < timeoutMs) {
    frame = page.frames().find((f) => f.url().includes(".app.localhost"));
    if (frame !== undefined) {
      break;
    }
    await page.waitForTimeout(200);
  }
  if (frame === undefined) {
    throw new Error(
      `Sandbox iframe never appeared within ${String(timeoutMs)}ms`,
    );
  }
  const remaining = Math.max(1000, timeoutMs - (Date.now() - start));
  await frame.waitForFunction(
    () =>
      performance
        .getEntriesByType("mark")
        .some((m) => m.name === "dotli:app:end"),
    { timeout: remaining, polling: 500 },
  );
  return frame;
}

/** Read `window.location` from inside the product Frame in one round-trip. */
export async function getProductLocation(
  frame: Frame,
): Promise<ProductLocation> {
  return frame.evaluate(() => ({
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
    href: window.location.href,
  }));
}

/**
 * Assert that none of the host-to-sandbox contract keys leaked into the
 * product's `window.location.search`. Imports the contract names directly
 * so this can never drift from the source of truth.
 */
export function assertNoContractKeys(search: string): void {
  const params = new URLSearchParams(search);
  for (const key of Object.values(SANDBOX_CONTRACT_PARAMS)) {
    expect(
      params.has(key),
      `contract key "${key}" leaked into product location.search`,
    ).toBe(false);
  }
}

/** Wait for the host's error page; returns "title: detail" or "" on timeout. */
export async function waitForErrorPage(
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
 * Wait for an error page rendered INSIDE the sandbox iframe (e.g. validator
 * failures from `validateSandboxParams`). The sandbox calls `showError(...)`
 * which writes `.error-page-title` / `.error-page-detail` into the sandbox
 * Frame's DOM. This never reaches the host page, and `dotli:app:end` never
 * fires on validation failure, so the regular helpers don't apply.
 *
 * Returns "title: detail" or "" on timeout.
 */
export async function waitForSandboxErrorPage(
  page: Page,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frames().find((f) => f.url().includes(".app.localhost"));
    if (frame !== undefined) {
      const title = await frame
        .locator(".error-page-title")
        .first()
        .textContent({ timeout: 500 })
        .catch(() => null);
      if (title !== null && title.length > 0) {
        const detail = await frame
          .locator(".error-page-detail")
          .first()
          .textContent({ timeout: 500 })
          .catch(() => "");
        return `${title}: ${detail ?? ""}`;
      }
    }
    await page.waitForTimeout(250);
  }
  return "";
}
