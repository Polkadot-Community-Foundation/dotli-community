import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 600_000, // 10 min — smoldot sync can be slow
  retries: 0,
  use: {
    baseURL: "http://mytestapp.localhost:5173",
    browserName: "chromium",
    headless: process.env.HEADED !== "1",
    bypassCSP: true,
  },
  reporter: [["list"], ["json", { outputFile: "tests/results.json" }]],
  webServer: {
    command: "bunx --bun vite --host",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
