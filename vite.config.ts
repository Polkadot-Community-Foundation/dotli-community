import { defineConfig, build as viteBuild, type Plugin } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import wasm from "vite-plugin-wasm";

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
 * and Asset Hub bootnode hostnames. Reads them from the chain spec JSON files
 * at build time so they stay in sync with `npm run update-chain-specs`.
 *
 * `preconnect` establishes DNS + TCP + TLS during HTML parse, saving ~100-200ms
 * per peer when smoldot starts dialing WebSocket connections.
 */
function preconnectBootnodes(): Plugin {
  return {
    name: "preconnect-bootnodes",
    transformIndexHtml(html) {
      const specDir = resolve(__dirname, "src/chain-specs");
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
 * Vite plugin that injects a conditional <link rel="modulepreload"> for the
 * resolve chunk on subdomain pages. This lets the browser start downloading
 * the resolve chunk during HTML parse — before the main JS even executes.
 *
 * On the landing page (dot.li / localhost) nothing is injected.
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

        // Find critical chunk filenames from the bundle
        const bundleKeys = Object.keys(ctx.bundle);
        const findChunk = (pattern: RegExp) =>
          bundleKeys.find((name) => pattern.test(name));

        const resolveChunk = findChunk(/^assets\/resolve-.*\.js$/);
        const fetchChunk = findChunk(/^assets\/fetch-.*\.js$/);
        const renderChunk = findChunk(/^assets\/render-.*\.js$/);
        const gatewayChunk = findChunk(/^assets\/gateway-.*\.js$/);
        const wasmAsset = findChunk(/^assets\/.*\.wasm$/);
        const metadataAsset = findChunk(/^assets\/ah-.*\.scale$/);

        const chunks = [resolveChunk, fetchChunk, renderChunk, gatewayChunk].filter(Boolean);
        if (chunks.length === 0) return [];

        const b = resolvedBase;

        // Preload heavy assets as fetch (browser starts downloading during HTML parse)
        const fetchPreloads = [wasmAsset, metadataAsset].filter(Boolean)
          .map(
            (a) =>
              `l=document.createElement("link");l.rel="preload";l.as="fetch";l.crossOrigin="anonymous";l.href="${b}${a}";document.head.appendChild(l);`,
          )
          .join("");

        // Inline script that conditionally creates modulepreload links
        const preloadStatements = chunks
          .map(
            (c) =>
              `l=document.createElement("link");l.rel="modulepreload";l.href="${b}${c}";document.head.appendChild(l);`,
          )
          .join("");
        const script = [
          "(function(){",
          'var h=location.hostname,p=location.pathname,l;',
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
 * Vite plugin that builds the Service Worker (src/sw.ts) as a self-contained
 * ES module bundle after the main build completes.
 *
 * The SW runs smoldot + archive serving and is registered with { type: 'module' }.
 * It's built separately to ensure all dependencies are inlined (no shared chunks
 * with the main app, avoiding version mismatch on SW updates).
 */
function buildServiceWorker(): Plugin {
  return {
    name: "build-service-worker",
    apply: "build",
    async closeBundle() {
      console.log("\nBuilding Service Worker...");
      await viteBuild({
        configFile: false,
        plugins: [wasm()],
        build: {
          emptyOutDir: false,
          outDir: "dist",
          lib: {
            entry: resolve(__dirname, "src/sw.ts"),
            formats: ["es"],
            fileName: () => "sw.js",
          },
          rollupOptions: {
            output: {
              inlineDynamicImports: true,
            },
          },
          // SW doesn't need source maps in production
          sourcemap: false,
          minify: true,
        },
        // Suppress most output
        logLevel: "warn",
      });
      console.log("Service Worker built → dist/sw.js\n");
    },
  };
}

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  plugins: [
    wasm(),
    preconnectBootnodes(),
    preloadCriticalAssets(),
    buildServiceWorker(),
  ],
  build: {
    target: "esnext",
    modulePreload: { polyfill: false },
  },
  server: {
    headers: {
      // Allow the SW at /src/sw.ts to control scope "/" in dev mode
      "Service-Worker-Allowed": "/",
    },
  },
});
