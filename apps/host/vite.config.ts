import { sentryVitePlugin } from "@sentry/vite-plugin";
import { defineConfig, build as viteBuild, type Plugin } from "vite";
import { readFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import wasm from "vite-plugin-wasm";

const OUT_DIR = "dist";

/**
 * Extract unique WSS bootnode hostnames from a chain spec JSON file.
 */
function extractBootnodeHosts(specPath: string): string[] {
  try {
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as {
      bootNodes?: string[];
    };
    const hosts = new Set<string>();
    for (const bn of spec.bootNodes ?? []) {
      if (bn.includes("/wss/") || bn.includes("/tls/ws/")) {
        const match = /\/dns[46]?\/([^/]+)/.exec(bn);
        if (match?.[1]) hosts.add(match[1]);
      }
    }
    return [...hosts];
  } catch {
    return [];
  }
}

/**
 * Vite plugin that injects <link rel="preconnect"> for smoldot relay chain
 * and Asset Hub bootnode hostnames.
 */
function preconnectBootnodes(): Plugin {
  return {
    name: "preconnect-bootnodes",
    transformIndexHtml(html) {
      const specDir = resolve(
        import.meta.dirname,
        "../../packages/core/src/chain-specs",
      );
      const hosts = [
        ...extractBootnodeHosts(resolve(specDir, "paseo.json")),
        ...extractBootnodeHosts(resolve(specDir, "asset-hub-paseo.json")),
      ];
      const unique = [...new Set(hosts)];
      const links = unique
        .map(
          (host) =>
            `<link rel="preconnect" href="https://${host}" crossorigin />`,
        )
        .join("\n    ");
      return html.replace("</head>", `    ${links}\n  </head>`);
    },
  };
}

/**
 * Vite plugin that injects conditional <link rel="modulepreload"> for
 * critical chunks on subdomain pages.
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

        const resolveChunk = findChunk(/^assets\/resolve-.*\.js$/);
        const fetchChunk = findChunk(/^assets\/fetch-.*\.js$/);
        const renderChunk = findChunk(/^assets\/render-.*\.js$/);
        const gatewayChunk = findChunk(/^assets\/gateway-.*\.js$/);
        const wasmAsset = findChunk(/^assets\/.*\.wasm$/);
        const metadataAsset = findChunk(/^assets\/ah-.*\.scale$/);

        const chunks = [
          resolveChunk,
          fetchChunk,
          renderChunk,
          gatewayChunk,
        ].filter(Boolean);
        if (chunks.length === 0) return [];

        const b = resolvedBase;

        const fetchPreloads = [wasmAsset, metadataAsset]
          .filter(Boolean)
          .map(
            (a) =>
              `l=document.createElement("link");l.rel="preload";l.as="fetch";l.crossOrigin="anonymous";l.href="${b}${a}";document.head.appendChild(l);`,
          )
          .join("");

        const preloadStatements = chunks
          .map(
            (c) =>
              `l=document.createElement("link");l.rel="modulepreload";l.href="${b}${c}";document.head.appendChild(l);`,
          )
          .join("");
        const script = [
          "(function(){",
          "var h=location.hostname,p=location.pathname,l;",
          'if(h==="dot.li"||h==="localhost")return;',
          'if(!h.endsWith(".dot.li")&&!h.endsWith(".localhost")&&!/\\/[^/]+\\.dot(?:\\/|$)/.test(p))return;',
          fetchPreloads,
          preloadStatements,
          "})()",
        ].join("");

        return [
          {
            tag: "script",
            children: script,
            injectTo: "head",
          },
        ];
      },
    },
  };
}

/**
 * GitHub Pages SPA fallback: copy index.html -> 404.html.
 */
function githubPages404(): Plugin {
  return {
    name: "github-pages-404",
    apply: "build",
    closeBundle() {
      const dist = resolve(import.meta.dirname, OUT_DIR);
      copyFileSync(resolve(dist, "index.html"), resolve(dist, "404.html"));
      console.log(
        "Copied index.html -> 404.html (GitHub Pages SPA fallback)\n",
      );
    },
  };
}

/**
 * Build the Service Worker as a self-contained ES module bundle.
 */
function buildServiceWorker(): Plugin {
  return {
    name: "build-service-worker",
    apply: "build",
    async closeBundle() {
      console.log("\nBuilding Service Worker (host-sw)...");
      await viteBuild({
        configFile: false,
        plugins: [wasm()],
        resolve: {
          alias: {
            "@dotli/core": resolve(
              import.meta.dirname,
              "../../packages/core/src",
            ),
          },
        },
        build: {
          emptyOutDir: false,
          outDir: OUT_DIR,
          lib: {
            entry: resolve(import.meta.dirname, "src/host-sw.ts"),
            formats: ["es"],
            fileName: () => "host-sw.js",
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
      console.log(`Service Worker built -> ${OUT_DIR}/host-sw.js\n`);
    },
  };
}

const CORE_SRC = resolve(import.meta.dirname, "../../packages/core/src");
const SANDBOX_CHECKER_SRC = resolve(
  import.meta.dirname,
  "../../packages/sandbox-checker/src",
);

export default defineConfig({
  base: process.env.VITE_APP_URL
    ? new URL(process.env.VITE_APP_URL).pathname
    : "/",
  plugins: [
    wasm(),
    preconnectBootnodes(),
    preloadCriticalAssets(),
    buildServiceWorker(),
    githubPages404(),
    sentryVitePlugin({
      org: "paritytech",
      project: "dotli",
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
      "@dotli/core": CORE_SRC,
      "@dotli/sandbox-checker": SANDBOX_CHECKER_SRC,
    },
  },
  define: {
    __BUILD_TARGET__: JSON.stringify("host"),
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
