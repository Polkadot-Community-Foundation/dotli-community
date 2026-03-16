// dot.li — App context entry point
//
// Runs on cid.app.dot.li — parses the CID from the subdomain,
// fetches content via P2P/gateway, and renders it in a sandboxed iframe.
// No dotns resolution, no smoldot, no topbar.

import "@dotli/core/styles.css";
import * as Sentry from "@sentry/browser";
import type { ArchiveFiles } from "@dotli/core/archive";
import { showStatus, showError } from "@dotli/core/ui";
import { TIMEOUTS, BASE_DOMAIN } from "@dotli/core/config";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN as string,
});

const T0 = performance.now();
function elapsed(): string {
  return `+${((performance.now() - T0) / 1000).toFixed(3)}s`;
}

/**
 * Extract the CID from the hostname.
 *
 * Examples:
 *   "bafyrei1234.app.dot.li"     → "bafyrei1234"
 *   "bafyrei1234.app.localhost"   → "bafyrei1234"
 *   "app.dot.li"                  → null (bare app domain)
 *   "dot.li"                      → null
 */
function parseCidFromHostname(): string | null {
  const hostname = window.location.hostname;

  // Production: cid.app.{BASE_DOMAIN}
  const appSuffix = `.app.${BASE_DOMAIN}`;
  if (hostname.endsWith(appSuffix)) {
    const cid = hostname.slice(0, -appSuffix.length);
    return cid || null;
  }

  // Local dev: cid.app.localhost
  if (hostname.endsWith(".app.localhost")) {
    const cid = hostname.slice(0, -".app.localhost".length);
    return cid || null;
  }

  return null;
}

/**
 * Check if the Service Worker has a cached archive for this CID.
 */
async function getCachedArchive(
  domain: string,
  cid: string,
): Promise<ArchiveFiles | null> {
  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    return null;
  }

  return new Promise<ArchiveFiles | null>((resolve) => {
    const timeout = setTimeout(() => {
      resolve(null);
    }, TIMEOUTS.SW_CACHE_LOOKUP);
    const channel = new MessageChannel();

    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timeout);
      const msg = event.data as {
        found?: boolean;
        cid?: string;
        files?: Record<string, ArrayBuffer | Uint8Array> | null;
      };
      if (
        msg.found === true &&
        msg.cid === cid &&
        msg.files !== undefined &&
        msg.files !== null
      ) {
        const raw = msg.files;
        const files: ArchiveFiles = {};
        for (const [path, data] of Object.entries(raw)) {
          files[path] =
            data instanceof Uint8Array ? data : new Uint8Array(data);
        }
        resolve(files);
      } else {
        resolve(null);
      }
    };

    controller.postMessage({ type: "SW_CACHE_LOOKUP_EVENT", domain }, [
      channel.port2,
    ]);
  });
}

/**
 * Register the app Service Worker for archive serving.
 */
async function registerAppServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    const swUrl = import.meta.env.DEV
      ? "/src/app-sw.ts"
      : `${import.meta.env.BASE_URL}app-sw.js`;
    const swScope = import.meta.env.DEV ? "/" : import.meta.env.BASE_URL;
    await navigator.serviceWorker.register(swUrl, {
      type: "module",
      scope: swScope,
    });

    if (navigator.serviceWorker.controller) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Service Worker not available after 10s"));
      }, TIMEOUTS.SW_READY);
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        clearTimeout(timeout);
        resolve();
      });
      void navigator.serviceWorker.ready.then((registration) => {
        if (navigator.serviceWorker.controller) {
          clearTimeout(timeout);
          resolve();
        } else if (registration.active) {
          registration.active.postMessage({ type: "SW_CLAIM_EVENT" });
        }
      });
    });
  } catch (err) {
    console.warn("[dot.li app] Service worker registration failed:", err);
  }
}

/**
 * Store archive files in the Service Worker so it can serve sub-resources.
 * Must be called before document.write() for multi-file archives in relay mode,
 * otherwise CSS/JS requests fall through to nginx which returns the HTML fallback.
 */
async function storeArchiveInSW(
  files: ArchiveFiles,
  domain: string,
  cid: string,
): Promise<void> {
  const sw = navigator.serviceWorker.controller;
  if (!sw) {
    return;
  }

  const entries = Object.entries(files);
  const index: { p: string; o: number; l: number }[] = [];
  let totalSize = 0;
  for (const [, data] of entries) {
    totalSize += data.byteLength;
  }
  const packed = new ArrayBuffer(totalSize);
  const packedView = new Uint8Array(packed);
  let offset = 0;
  for (const [filePath, data] of entries) {
    index.push({ p: filePath, o: offset, l: data.byteLength });
    packedView.set(data, offset);
    offset += data.byteLength;
  }

  const archiveReady = new Promise<void>((resolve) => {
    const handler = (evt: MessageEvent): void => {
      if ((evt.data as { type?: string } | null)?.type === "ARCHIVE_READY") {
        navigator.serviceWorker.removeEventListener("message", handler);
        resolve();
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
  });

  sw.postMessage({ type: "SET_ARCHIVE", packed, index, domain, cid }, [packed]);

  await archiveReady;
}

/**
 * Optionally inject the sandbox checker script into HTML for relay mode.
 * In relay mode, document.write() replaces the page, so we must inject
 * the checker inline — the render.ts injection path is not used.
 */
async function maybeInjectSandboxChecker(html: string): Promise<string> {
  if (
    (import.meta.env.VITE_SANDBOX_CHECKER as string | undefined) === undefined
  ) {
    return html;
  }
  const { injectSandboxChecker } =
    await import("@dotli/sandbox-checker/sandbox-checker");
  return injectSandboxChecker(html);
}

// Module-level reference for cleanup
let destroyHeliaFn: (() => Promise<void>) | null = null;

async function main(): Promise<void> {
  performance.mark("dotli:app:start");
  console.warn(`[dot.li app] main() started (${elapsed()})`);

  const cid = parseCidFromHostname();
  if (cid === null) {
    showError(
      "No CID",
      `This page requires a CID in the subdomain (e.g. bafyrei....app.${BASE_DOMAIN})`,
    );
    return;
  }

  console.warn(`[dot.li app] CID from hostname: ${cid}`);
  showStatus("Loading content...");

  // Register SW + pre-load chunks in parallel
  const swReady = registerAppServiceWorker();
  const renderChunkPromise = import("@dotli/core/render");
  const fetchChunkPromise = import("@dotli/core/fetch");

  // Wait for SW before cache check
  await swReady;
  console.warn(`[dot.li app] SW ready (${elapsed()})`);

  // Detect relay mode: APP is inside the HOST iframe.
  // The HOST's container bridge targets this iframe directly.
  // The dApp SDK uses window.top for postMessage, so the dApp must run
  // at this iframe level (not nested further). In relay mode, we replace
  // the document with the dApp's HTML via document.write() so the dApp
  // occupies this window and can talk to the HOST's bridge via window.top.
  const isRelayMode = window.self !== window.top;

  // Check SW cache first
  const cachedFiles = await getCachedArchive(cid, cid);
  if (cachedFiles) {
    console.warn(`[dot.li app] SW archive cache HIT (${elapsed()})`);

    if (isRelayMode) {
      // Extract index.html and write it directly into this window
      const indexHtml = cachedFiles["index.html"] as Uint8Array | undefined;
      if (indexHtml) {
        // For multi-file archives, store files in the SW so it can serve
        // sub-resources (CSS, JS, fonts) when the browser loads them.
        if (Object.keys(cachedFiles).length > 1) {
          await storeArchiveInSW(cachedFiles, cid, cid);
          console.warn(
            `[dot.li app] Relay mode: archive stored in SW (${elapsed()})`,
          );
        }
        let html = new TextDecoder().decode(indexHtml);
        html = await maybeInjectSandboxChecker(html);
        console.warn(
          `[dot.li app] Relay mode: writing cached content into window (${elapsed()})`,
        );
        performance.mark("dotli:app:end");
        document.open();
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional: document.write replaces the page with dApp content to eliminate triple iframe nesting
        document.write(html);
        document.close();
        return;
      }
    }

    showStatus("Rendering (cached)...");
    const { renderArchive } = await renderChunkPromise;
    await renderArchive(cachedFiles, cid, cid);
    performance.mark("dotli:app:end");
    console.warn(`[dot.li app] Done — cached (${elapsed()})`);
    return;
  }

  // Fetch via P2P / gateway
  console.warn(
    `[dot.li app] SW archive cache MISS — fetching via P2P (${elapsed()})`,
  );
  showStatus("Connecting to peers...");
  const { fetchArchive, ensureHelia, destroyHelia } = await fetchChunkPromise;
  destroyHeliaFn = destroyHelia;
  await ensureHelia();
  console.warn(`[dot.li app] Helia P2P ready (${elapsed()})`);
  const result = await fetchArchive(cid, showStatus);
  console.warn(`[dot.li app] Content fetched → ${result.type} (${elapsed()})`);

  if (isRelayMode) {
    // Write the dApp content directly into this window so it occupies
    // the APP iframe. The HOST's container bridge communicates with this
    // iframe via window.top ↔ iframe.contentWindow.
    let html: string | null = null;
    if (result.type === "single") {
      html = new TextDecoder().decode(result.content);
    } else {
      // For multi-file archives, store files in the SW so it can serve
      // sub-resources (CSS, JS, fonts) when the browser loads them.
      await storeArchiveInSW(result.files, cid, cid);
      console.warn(
        `[dot.li app] Relay mode: archive stored in SW (${elapsed()})`,
      );
      const indexHtml = result.files["index.html"] as Uint8Array | undefined;
      if (indexHtml) {
        html = new TextDecoder().decode(indexHtml);
      }
    }

    if (html !== null) {
      html = await maybeInjectSandboxChecker(html);
      console.warn(
        `[dot.li app] Relay mode: writing content into window (${elapsed()})`,
      );
      performance.mark("dotli:app:end");
      document.open();
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional: document.write replaces the page with dApp content to eliminate triple iframe nesting
      document.write(html);
      document.close();
      return;
    }
  }

  // Render in sub-iframe (standalone mode or archive fallback)
  showStatus("Rendering...");
  const { renderArchive, renderContent } = await renderChunkPromise;
  if (result.type === "archive") {
    await renderArchive(result.files, cid, cid);
  } else {
    await renderContent(result.content, cid);
  }

  performance.mark("dotli:app:end");
  console.warn(`[dot.li app] Done (${elapsed()})`);
}

// Cleanup on page unload
window.addEventListener("beforeunload", () => {
  if (destroyHeliaFn) {
    void destroyHeliaFn();
  }
});

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  showError("Failed to load content", message);
});
