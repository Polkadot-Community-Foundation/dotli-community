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
 * Vite plugin that injects <link rel="dns-prefetch"> for smoldot relay chain
 * and Asset Hub bootnode hostnames. Reads them from the chain spec JSON files
 * at build time so they stay in sync with `npm run update-chain-specs`.
 */
function dnsPrefetchBootnodes(): Plugin {
  return {
    name: "dns-prefetch-bootnodes",
    transformIndexHtml() {
      const specDir = resolve(__dirname, "src/chain-specs");
      const hosts = [
        ...extractBootnodeHosts(resolve(specDir, "paseo.json")),
        ...extractBootnodeHosts(resolve(specDir, "asset-hub-paseo.json")),
      ];
      // Deduplicate
      const unique = [...new Set(hosts)];
      return unique.map((host) => ({
        tag: "link",
        attrs: { rel: "dns-prefetch", href: `//${host}` },
        injectTo: "head" as const,
      }));
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
  return {
    name: "preload-critical-assets",
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

        const chunks = [resolveChunk, fetchChunk, renderChunk].filter(Boolean);
        if (chunks.length === 0) return [];

        // Inline script that conditionally creates modulepreload links
        const preloadStatements = chunks
          .map(
            (c) =>
              `l=document.createElement("link");l.rel="modulepreload";l.href="/${c}";document.head.appendChild(l);`,
          )
          .join("");
        const script = [
          "(function(){",
          'var h=location.hostname,l;',
          'if(h==="dot.li"||h==="localhost")return;',
          'if(!h.endsWith(".dot.li")&&!h.endsWith(".localhost"))return;',
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
  plugins: [
    wasm(),
    dnsPrefetchBootnodes(),
    preloadCriticalAssets(),
    buildServiceWorker(),
  ],
  server: {
    headers: {
      // Allow the SW at /src/sw.ts to control scope "/" in dev mode
      "Service-Worker-Allowed": "/",
    },
  },
});
