import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@dotli/core": resolve(import.meta.dirname, "src"),
      "@dotli/sandbox-checker": resolve(
        import.meta.dirname,
        "../sandbox-checker/src",
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "happy-dom",
    globals: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "tests/**",
        "src/codegen/**",
        "src/chain-specs/**",
        "src/**/*.d.ts",
        // Modules that require real browser APIs / smoldot / heavy deps
        "src/fetch.ts",
        "src/sw-smoldot.ts",
        "src/sw-provider.ts",
        "src/host-sw.ts",
        "src/app-sw.ts",
        "src/auth.ts",
        "src/topbar.ts",
        "src/container.ts",
        "src/signing.ts",
        "src/render.ts",
        "src/tauri-bridge.ts",
        "src/tauri-chains.ts",
        "src/ui.ts",
      ],
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 85,
      },
    },
  },
  define: {
    "import.meta.env.DEV": "false",
    "import.meta.env.VITE_APP_DEBUG": '"true"',
    __BUILD_TARGET__: '"host"',
  },
});
