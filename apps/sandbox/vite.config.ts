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
            "@dotli/core": resolve(__dirname, "../../packages/core/src"),
          },
        },
        build: {
          emptyOutDir: false,
          outDir: OUT_DIR,
          lib: {
            entry: resolve(__dirname, "src/app-sw.ts"),
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

const CORE_SRC = resolve(__dirname, "../../packages/core/src");
const SANDBOX_CHECKER_SRC = resolve(
  __dirname,
  "../../packages/sandbox-checker/src",
);

export default defineConfig({
  base: process.env.VITE_APP_URL
    ? new URL(process.env.VITE_APP_URL).pathname
    : "/",
  plugins: [wasm(), buildServiceWorker()],
  resolve: {
    alias: {
      "@dotli/core": CORE_SRC,
      "@dotli/sandbox-checker": SANDBOX_CHECKER_SRC,
    },
  },
  define: {
    __BUILD_TARGET__: JSON.stringify("app"),
  },
  build: {
    target: "esnext",
    modulePreload: { polyfill: false },
    outDir: OUT_DIR,
  },
  server: {
    headers: {
      "Service-Worker-Allowed": "/",
      "Access-Control-Allow-Origin": "*",
    },
  },
});
