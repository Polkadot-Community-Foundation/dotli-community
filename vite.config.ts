import { defineConfig, type Plugin } from "vite";
import wasm from "vite-plugin-wasm";

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

        // Find the resolve chunk filename from the bundle
        const resolveChunk = Object.keys(ctx.bundle).find((name) =>
          name.match(/^assets\/resolve-.*\.js$/),
        );
        if (!resolveChunk) return [];

        // Inline script that conditionally creates the modulepreload link
        const script = [
          "(function(){",
          'var h=location.hostname;',
          'if(h==="dot.li"||h==="localhost")return;',
          'if(!h.endsWith(".dot.li")&&!h.endsWith(".localhost"))return;',
          'var l=document.createElement("link");',
          'l.rel="modulepreload";',
          `l.href="/${resolveChunk}";`,
          "document.head.appendChild(l);",
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
