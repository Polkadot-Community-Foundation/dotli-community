import { defineConfig, type Plugin } from "vite";
import wasm from "vite-plugin-wasm";

/**
 * Inject conditional <link rel="modulepreload"> hints for critical chunks.
 *
 * On subdomain pages (name.dot.li), the browser starts downloading the resolve
 * chunk immediately during HTML parse — before the main JS even begins executing.
 * On the landing page (dot.li / localhost), no preloading occurs.
 */
function preloadCriticalAssets(): Plugin {
  return {
    name: "preload-critical-assets",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        // Only runs during build (ctx.bundle is available)
        if (!ctx.bundle) return;

        let resolveChunk = "";
        for (const fileName of Object.keys(ctx.bundle)) {
          if (/^assets\/resolve-[^.]+\.js$/.test(fileName)) {
            resolveChunk = fileName;
            break;
          }
        }

        if (!resolveChunk) return;

        // Inline script that conditionally injects modulepreload on subdomain pages
        const script = [
          "(function(){",
          "var h=location.hostname;",
          'if(h==="dot.li"||h==="localhost")return;',
          'if(!h.endsWith(".dot.li")&&!h.endsWith(".localhost"))return;',
          'var l=document.createElement("link");',
          'l.rel="modulepreload";',
          `l.href="/${resolveChunk}";`,
          "document.head.appendChild(l)",
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
  plugins: [wasm(), preloadCriticalAssets()],
});
