import { defineConfig, build as viteBuild, type Plugin } from "vite";
import { readFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import wasm from "vite-plugin-wasm";

// ── Build target configuration ──────────────────────────────
// BUILD_TARGET determines which entry point, SW, and output dir to use.
// "host" = name.dot.li (topbar, dotns resolution, smoldot)
// "app"  = cid.app.dot.li (CID fetch + render, no smoldot)

const BUILD_TARGET = (process.env.BUILD_TARGET ?? "host") as "host" | "app";
const IS_APP = BUILD_TARGET === "app";
const OUT_DIR = `dist/${BUILD_TARGET}`;

const SW_ENTRY: Record<string, string> = {
  host: "src/host-sw.ts",
  app: "src/app-sw.ts",
};
const SW_NAME: Record<string, string> = {
  host: "host-sw",
  app: "app-sw",
};

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
 * Host build only — app build doesn't use smoldot.
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
 * Vite plugin that injects conditional <link rel="modulepreload"> for
 * critical chunks on subdomain pages.
 * Host build only — app build has different chunk structure.
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

        const chunks = [resolveChunk, fetchChunk, renderChunk, gatewayChunk].filter(Boolean);
        if (chunks.length === 0) return [];

        const b = resolvedBase;

        const fetchPreloads = [wasmAsset, metadataAsset].filter(Boolean)
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
 * GitHub Pages SPA fallback: copy index.html → 404.html.
 * Host build only.
 */
function githubPages404(): Plugin {
  return {
    name: "github-pages-404",
    apply: "build",
    closeBundle() {
      const dist = resolve(__dirname, OUT_DIR);
      copyFileSync(resolve(dist, "index.html"), resolve(dist, "404.html"));
      console.log("Copied index.html → 404.html (GitHub Pages SPA fallback)\n");
    },
  };
}

/**
 * Build the Service Worker as a self-contained ES module bundle.
 * Uses the target-specific SW entry point and output directory.
 */
function buildServiceWorker(): Plugin {
  return {
    name: "build-service-worker",
    apply: "build",
    async closeBundle() {
      const swEntry = SW_ENTRY[BUILD_TARGET];
      const swName = SW_NAME[BUILD_TARGET];
      console.log(`\nBuilding Service Worker (${swName})...`);
      await viteBuild({
        configFile: false,
        plugins: [wasm()],
        build: {
          emptyOutDir: false,
          outDir: OUT_DIR,
          lib: {
            entry: resolve(__dirname, swEntry),
            formats: ["es"],
            fileName: () => `${swName}.js`,
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
      console.log(`Service Worker built → ${OUT_DIR}/${swName}.js\n`);
    },
  };
}

/**
 * Dev server plugin: rewrite "/" → "/app.html" when BUILD_TARGET=app.
 */
function appDevEntry(): Plugin {
  return {
    name: "app-dev-entry",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === "/" || req.url === "/index.html") {
          req.url = "/app.html";
        }
        next();
      });
    },
  };
}

export default defineConfig({
  base: process.env.VITE_APP_URL
    ? new URL(process.env.VITE_APP_URL).pathname
    : "/",
  plugins: [
    wasm(),
    !IS_APP && preconnectBootnodes(),
    !IS_APP && preloadCriticalAssets(),
    buildServiceWorker(),
    !IS_APP && githubPages404(),
    IS_APP && appDevEntry(),
  ].filter(Boolean) as Plugin[],
  define: {
    __BUILD_TARGET__: JSON.stringify(BUILD_TARGET),
  },
  build: {
    target: "esnext",
    modulePreload: { polyfill: false },
    outDir: OUT_DIR,
    ...(IS_APP && {
      rollupOptions: {
        input: resolve(__dirname, "app.html"),
      },
    }),
  },
  server: {
    headers: {
      "Service-Worker-Allowed": "/",
    },
  },
});
