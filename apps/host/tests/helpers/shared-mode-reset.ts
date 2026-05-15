import { test as base } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

const PORT = process.env.COMBO_PORT ?? "5173";

/**
 * Wipe the preview-server's process-wide mode-sync `Map` (see
 * `scripts/preview-server.ts`). Required between tests: a sibling spec's
 * `rpc-gateway` write shadows this test's per-context `localStorage` seed
 * during bootstrap, silently rerouting the host through the RPC path
 * (where mocked iframes are never queried — the 10s-timeout failure shape).
 */
export async function resetSharedMode(
  request: APIRequestContext,
): Promise<void> {
  const res = await request.delete(
    `http://host.localhost:${PORT}/__dotli-mode/`,
  );
  if (!res.ok()) {
    throw new Error(
      `[shared-mode-reset] preview-server returned HTTP ${String(res.status())}`,
    );
  }
}

/**
 * Drop-in replacement for `@playwright/test`'s `test` that auto-resets the
 * shared mode-sync store before every test. Specs that seed
 * `dotli:chain-backend` in `localStorage` should import `test` from here.
 */
export const test = base.extend<{ _resetSharedMode: void }>({
  _resetSharedMode: [
    async ({ request }, use) => {
      await resetSharedMode(request);
      await use();
    },
    { auto: true },
  ],
});
