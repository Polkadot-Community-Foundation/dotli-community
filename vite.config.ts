import { defineConfig, type Plugin } from "vite";
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

export default defineConfig({
  plugins: [wasm(), dnsPrefetchBootnodes(), preloadCriticalAssets()],
});
