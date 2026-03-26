import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@dotli/protocol": resolve(import.meta.dirname, "src"),
      "@dotli/config": resolve(import.meta.dirname, "../config/src"),
      "@dotli/shared": resolve(import.meta.dirname, "../shared/src"),
      "@dotli/resolver": resolve(import.meta.dirname, "../resolver/src"),
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
