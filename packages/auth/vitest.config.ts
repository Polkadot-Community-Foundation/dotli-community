import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@dotli/auth": resolve(import.meta.dirname, "src"),
      "@dotli/config": resolve(import.meta.dirname, "../config/src"),
      "@dotli/protocol": resolve(import.meta.dirname, "../protocol/src"),
      "@dotli/shared": resolve(import.meta.dirname, "../shared/src"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "happy-dom",
    globals: false,
  },
  define: {
    "import.meta.env.DEV": "false",
    "import.meta.env.VITE_APP_DEBUG": '"true"',
  },
});
