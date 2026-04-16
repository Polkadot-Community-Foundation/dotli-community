import { sentryVitePlugin } from "@sentry/vite-plugin";
import { defineConfig, type Plugin } from "vite";
import { readFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import wasm from "vite-plugin-wasm";
import { VitePWA } from "vite-plugin-pwa";

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
        "../../packages/resolver/src/chain-specs",
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
        const wasmAsset = findChunk(/^assets\/.*\.wasm$/);
        const metadataAsset = findChunk(/^assets\/ah-.*\.scale$/);

        const chunks = [resolveChunk, fetchChunk, renderChunk].filter(Boolean);
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
    writeBundle() {
      const dist = resolve(import.meta.dirname, OUT_DIR);
      copyFileSync(resolve(dist, "index.html"), resolve(dist, "404.html"));
      console.log(
        "Copied index.html -> 404.html (GitHub Pages SPA fallback)\n",
      );
    },
  };
}

/**
 * Sentry plugin — only active when SENTRY_AUTH_TOKEN is set (CI deploys).
 * Skipped locally so source maps are preserved for debugging.
 */
function sentry(project: string): Plugin | false {
  if (!process.env.SENTRY_AUTH_TOKEN) return false;
  return sentryVitePlugin({
    org: "paritytech",
    project,
    telemetry: false,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    release: { name: process.env.VITE_COMMIT_SHA },
    sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
  });
}

const { version } = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "package.json"), "utf8"),
) as { version: string };

const PACKAGES = resolve(import.meta.dirname, "../../packages");
const SANDBOX_CHECKER_SRC = resolve(PACKAGES, "sandbox-checker/src");

export default defineConfig({
  base: process.env.VITE_APP_URL
    ? new URL(process.env.VITE_APP_URL).pathname
    : "/",
  plugins: [
    wasm(),
    preconnectBootnodes(),
    preloadCriticalAssets(),
    githubPages404(),
    sentry("dotli"),
    VitePWA({
      injectRegister: false,
      filename: "host-sw.js",
      manifest: {
        name: "dot.li",
        short_name: "dot.li",
        description: "Decentralized web browser for Polkadot",
        theme_color: "#E6007A",
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,wasm}"],
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api\//],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
      },
    }),
  ],
  resolve: {
    alias: {
      "@dotli/config": resolve(PACKAGES, "config/src"),
      "@dotli/metrics": resolve(PACKAGES, "metrics/src"),
      "@dotli/shared": resolve(PACKAGES, "shared/src"),
      "@dotli/storage": resolve(PACKAGES, "storage/src"),
      "@dotli/resolver": resolve(PACKAGES, "resolver/src"),
      "@dotli/protocol": resolve(PACKAGES, "protocol/src"),
      "@dotli/content": resolve(PACKAGES, "content/src"),
      "@dotli/auth": resolve(PACKAGES, "auth/src"),
      "@dotli/ui": resolve(PACKAGES, "ui/src"),
      "@dotli/sandbox-checker": SANDBOX_CHECKER_SRC,
    },
  },
  define: {
    __BUILD_TARGET__: JSON.stringify("host"),
    __APP_VERSION__: JSON.stringify(version),
  },
  optimizeDeps: {
    exclude: ["@polkadot-api/wasm-executor", "verifiablejs"],
  },
  build: {
    target: "esnext",
    modulePreload: { polyfill: false },
    outDir: OUT_DIR,
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@novasamatech/scale")) {
            return "nova-scale";
          }
        },
      },
    },
  },
  server: {
    headers: {
      "Service-Worker-Allowed": "/",
      "Access-Control-Allow-Origin": "*",
    },
  },
});
