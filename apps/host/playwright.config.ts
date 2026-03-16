import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 900_000, // 15 min — smoldot sync can be slow
  retries: 0,
  use: {
    baseURL: "http://mytestapp.localhost:5173",
    browserName: "chromium",
    headless: process.env.HEADED !== "1",
    bypassCSP: true,
  },
  reporter: [["list"], ["json", { outputFile: "tests/results.json" }]],
  webServer: {
    command:
      "bun run build:host && bun run build:app && bun scripts/preview-server.ts",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
