import { defineConfig } from "@playwright/test";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");

// Load repo-root .env (bun's autoload only picks the cwd one).
try {
  const env = readFileSync(resolve(repoRoot, ".env"), "utf-8");
  for (const line of env.split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key]) continue;
    process.env[key] = raw.replace(/^['"]|['"]$/g, "");
  }
} catch {
  /* no .env — env must already be set */
}

// Stale-dist guard. The preview server serves built artifacts from
// `apps/{host,sandbox,protocol}/dist`; if those are older than the lockfile
// we're almost certainly running against an out-of-date build (we burned an
// afternoon on this once — the symptoms look like obscure SDK byte-parity
// bugs but the fix is `bun run build`). CI is unaffected because it always
// builds fresh; this only fires for local repeat runs.
if (process.env.CI !== "true") {
  try {
    const lockMtime = statSync(resolve(repoRoot, "bun.lock")).mtimeMs;
    for (const app of ["host", "sandbox", "protocol"]) {
      const distIndex = resolve(repoRoot, `apps/${app}/dist/index.html`);
      const distMtime = statSync(distIndex).mtimeMs;
      if (distMtime < lockMtime) {
        throw new Error(
          `apps/${app}/dist is older than bun.lock — run \`bun run build\` from the repo root before re-running e2e.`,
        );
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("ENOENT")) {
      throw new Error(
        "dist directories missing — run `bun run build` from the repo root before running e2e.",
      );
    }
    throw e;
  }
}

export default defineConfig({
  testDir: "./tests",
  timeout: 300_000,
  retries: 0,
  workers: 1,
  use: {
    browserName: "chromium",
    headless: process.env.HEADED !== "1",
    bypassCSP: true,
    launchOptions: {
      slowMo: process.env.SLOWMO ? Number(process.env.SLOWMO) : 0,
    },
    trace: "retain-on-failure",
    video: "off",
  },
  reporter: [["list"], ["json", { outputFile: "test-results/results.json" }]],
  webServer: {
    command: "bun ../../../scripts/preview-server.ts",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
