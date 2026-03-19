import { sentryVitePlugin } from "@sentry/vite-plugin";
import { defineConfig, build as viteBuild, type Plugin } from "vite";
import { resolve } from "node:path";
import wasm from "vite-plugin-wasm";

const OUT_DIR = "dist";

/**
 * Build the Service Worker as a self-contained ES module bundle.
 */
function buildServiceWorker(): Plugin {
  return {
    name: "build-service-worker",
    apply: "build",
    async closeBundle() {
      console.log("\nBuilding Service Worker (app-sw)...");
      await viteBuild({
        configFile: false,
        plugins: [wasm()],
        resolve: {
          alias: {
            "@dotli/config": resolve(
              import.meta.dirname,
              "../../packages/config/src",
            ),
            "@dotli/shared": resolve(
              import.meta.dirname,
              "../../packages/shared/src",
            ),
          },
        },
        build: {
          emptyOutDir: false,
          outDir: OUT_DIR,
          lib: {
            entry: resolve(import.meta.dirname, "src/app-sw.ts"),
            formats: ["es"],
            fileName: () => "app-sw.js",
          },
          rollupOptions: {
            output: {
              inlineDynamicImports: true,
            },
          },
          sourcemap: false,
          minify: true,
        },
        logLevel: "warn",
      });
      console.log(`Service Worker built -> ${OUT_DIR}/app-sw.js\n`);
    },
  };
}

/**
 * Vite plugin that injects <link rel="modulepreload"> for critical chunks
 * (fetch/P2P and render) so the browser starts downloading them during
 * HTML parse instead of waiting for the entry module to import() them.
 */
function preloadCriticalAssets(): Plugin {
  let resolvedBase = "/";
  return {
    name: "preload-critical-assets",
    configResolved(config) {
      resolvedBase = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        if (!ctx.bundle) return [];

        const bundleKeys = Object.keys(ctx.bundle);
        const findChunk = (pattern: RegExp) =>
          bundleKeys.find((name) => pattern.test(name));

        const fetchChunk = findChunk(/^assets\/fetch-.*\.js$/);
        const renderChunk = findChunk(/^assets\/render-.*\.js$/);

        const chunks = [fetchChunk, renderChunk].filter(Boolean);
        if (chunks.length === 0) return [];

        return chunks.map((c) => ({
          tag: "link",
          attrs: { rel: "modulepreload", href: `${resolvedBase}${c}` },
          injectTo: "head" as const,
        }));
      },
    },
  };
}

const PACKAGES = resolve(import.meta.dirname, "../../packages");
const SANDBOX_CHECKER_SRC = resolve(PACKAGES, "sandbox-checker/src");

export default defineConfig({
  base: process.env.VITE_APP_URL
    ? new URL(process.env.VITE_APP_URL).pathname
    : "/",
  plugins: [
    wasm(),
    preloadCriticalAssets(),
    buildServiceWorker(),
    sentryVitePlugin({
      org: "paritytech",
      project: "dotli-sandbox",
      telemetry: false,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      release: {
        name: process.env.VITE_COMMIT_SHA,
      },
      sourcemaps: {
        filesToDeleteAfterUpload: ["./dist/**/*.map"],
      },
    }),
  ],
  resolve: {
    alias: {
      "@dotli/config": resolve(PACKAGES, "config/src"),
      "@dotli/shared": resolve(PACKAGES, "shared/src"),
      "@dotli/storage": resolve(PACKAGES, "storage/src"),
      "@dotli/resolver": resolve(PACKAGES, "resolver/src"),
      "@dotli/content": resolve(PACKAGES, "content/src"),
      "@dotli/auth": resolve(PACKAGES, "auth/src"),
      "@dotli/ui": resolve(PACKAGES, "ui/src"),
      "@dotli/sandbox-checker": SANDBOX_CHECKER_SRC,
    },
  },
  define: {
    __BUILD_TARGET__: JSON.stringify("app"),
  },
  optimizeDeps: {
    exclude: ["@polkadot-api/wasm-executor", "verifiablejs"],
  },
  build: {
    target: "esnext",
    modulePreload: { polyfill: false },
    outDir: OUT_DIR,
    sourcemap: true,
  },
  server: {
    headers: {
      "Service-Worker-Allowed": "/",
      "Access-Control-Allow-Origin": "*",
    },
  },
});
