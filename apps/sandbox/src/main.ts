// dot.li — App context entry point
//
// Runs on cid.app.dot.li — parses the CID from the subdomain,
// fetches content via P2P, and renders it in a sandboxed iframe.
// No dotns resolution, no smoldot, no topbar.

// Reload once on chunk load failure (stale HTML referencing deleted assets).
window.addEventListener("vite:preloadError", () => {
  if (sessionStorage.getItem("dotli:chunk-reload") === null) {
    sessionStorage.setItem("dotli:chunk-reload", "1");
    window.location.reload();
  }
});

import "@dotli/ui/styles.css";
import * as Sentry from "@sentry/browser";
import { packArchive, type ArchiveFiles } from "@dotli/content/archive";
import { isEncrypted, decryptContent } from "@dotli/content/decrypt";
import {
  showStatus as showStatusLocal,
  showError,
  dismissLoading,
} from "@dotli/ui/ui";
import { showPasswordPrompt } from "@dotli/ui/password-prompt";
import { TIMEOUTS, BASE_DOMAIN } from "@dotli/config/config";
import { elapsed } from "@dotli/shared/perf";
import { log } from "@dotli/shared/log";
import { parseIpfsResponse } from "@dotli/content/archive";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN_SANDBOX as string | undefined,
  tunnel: "/t/sandbox",
  environment:
    (import.meta.env.VITE_APP_ENV as string | undefined) ?? "development",
  release: import.meta.env.VITE_COMMIT_SHA as string | undefined,
  sendDefaultPii: false,
});

import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
m.bind(Sentry as unknown as Parameters<typeof m.bind>[0]);

const T0 = performance.now();

// In relay mode (inside host iframe), post status to parent so the host's
// unified loading UI stays active. Otherwise update our own DOM.
const isRelayMode = window.self !== window.top;

// In relay mode the host shows the loading UI — hide the sandbox's own copy.
if (isRelayMode) {
  const loading = document.querySelector<HTMLElement>("#app > .loading");
  if (loading) {
    loading.style.display = "none";
  }
}

function showStatus(message: string): void {
  if (isRelayMode) {
    window.parent.postMessage({ type: "dotli:loading-status", message }, "*");
  } else {
    showStatusLocal(message);
  }
}

function notifyLoadingDone(): void {
  if (isRelayMode) {
    window.parent.postMessage(
      { type: "dotli:loading-status", done: true },
      "*",
    );
  }
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
    log.warn("[dot.li app] Service worker registration failed:", err);
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

  const { packed, index } = packArchive(files);

  const archiveReady = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      navigator.serviceWorker.removeEventListener("message", handler);
      reject(
        new Error("Service worker did not acknowledge archive within 10s"),
      );
    }, 10_000);

    const handler = (evt: MessageEvent): void => {
      if ((evt.data as { type?: string } | null)?.type === "ARCHIVE_READY") {
        clearTimeout(timer);
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

// Session-scoped decryption key cache: once a user decrypts a CID in this tab,
// we store the password so SW-cache hits don't re-prompt.
const decryptedPasswords = new Map<string, string>();

/**
 * If `data` is an encrypted blob, prompt for a password, decrypt, and parse.
 * Returns null if the data is not encrypted (caller should handle normally).
 */
async function decryptIfNeeded(
  data: Uint8Array,
  cid: string,
): Promise<ArchiveFiles | null> {
  if (!isEncrypted(data)) {
    return null;
  }
  log.warn(`[dot.li app] Content is encrypted, prompting for password...`);

  // Dismiss the loading overlay so it doesn't cover the password prompt.
  // In relay mode this tells the host to remove its overlay; in standalone
  // mode it removes the local one.
  dismissLoading();
  notifyLoadingDone();

  // Re-use password from this session if available
  let password = decryptedPasswords.get(cid);
  let error: string | undefined;

  for (;;) {
    password ??= await showPasswordPrompt({ error });
    try {
      const plaintext = await decryptContent(data, password);
      decryptedPasswords.set(cid, password);
      // Parse the decrypted bytes as an archive or single file
      return await parseIpfsResponse(plaintext);
    } catch {
      error = "Wrong password. Please try again.";
      password = undefined;
    }
  }
}

// Module-level reference for cleanup
let destroyHeliaFn: (() => Promise<void>) | null = null;

async function main(): Promise<void> {
  const stopApp = m.timer(S.APP_TOTAL);
  performance.mark("dotli:app:start");
  log.warn(`[dot.li app] main() started (${elapsed(T0)})`);

  const cid = parseCidFromHostname();
  if (cid === null) {
    showError(
      "No CID",
      `This page requires a CID in the subdomain (e.g. bafyrei....app.${BASE_DOMAIN})`,
    );
    stopApp();
    return;
  }

  log.warn(`[dot.li app] CID from hostname: ${cid}`);
  showStatus("Loading content...");

  // Register SW + pre-load chunks in parallel
  const stopSw = m.timer(S.APP_SW_REGISTER);
  const swReady = registerAppServiceWorker().then((v) => {
    stopSw();
    return v;
  });
  const renderChunkPromise = import("@dotli/ui/render");
  const fetchChunkPromise = import("@dotli/content/fetch");

  // Wait for SW before cache check
  await swReady;
  log.warn(`[dot.li app] SW ready (${elapsed(T0)})`);

  // Check SW cache first
  const cachedFiles = await getCachedArchive(cid, cid);
  if (cachedFiles) {
    log.warn(`[dot.li app] SW archive cache HIT (${elapsed(T0)})`);

    if (isRelayMode) {
      // Extract index.html and write it directly into this window
      const indexHtml = cachedFiles["index.html"] as Uint8Array | undefined;
      if (indexHtml) {
        // For multi-file archives, store files in the SW so it can serve
        // sub-resources (CSS, JS, fonts) when the browser loads them.
        if (Object.keys(cachedFiles).length > 1) {
          await storeArchiveInSW(cachedFiles, cid, cid);
          log.warn(
            `[dot.li app] Relay mode: archive stored in SW (${elapsed(T0)})`,
          );
        }
        let html = new TextDecoder().decode(indexHtml);
        html = await maybeInjectSandboxChecker(html);
        log.warn(
          `[dot.li app] Relay mode: writing cached content into window (${elapsed(T0)})`,
        );
        notifyLoadingDone();
        performance.mark("dotli:app:end");
        stopApp();
        document.open();
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional: document.write replaces the page with dApp content to eliminate triple iframe nesting
        document.write(html);
        document.close();
        return;
      }
    }

    showStatus("Rendering (cached)...");
    const stopRender = m.timer(S.APP_RENDER);
    const { renderArchive } = await renderChunkPromise;
    await renderArchive(cachedFiles, cid, cid);
    stopRender();
    notifyLoadingDone();
    performance.mark("dotli:app:end");
    log.warn(`[dot.li app] Done — cached (${elapsed(T0)})`);
    stopApp();
    return;
  }

  // Fetch via P2P
  log.warn(
    `[dot.li app] SW archive cache MISS — fetching via P2P (${elapsed(T0)})`,
  );
  showStatus("Connecting to peers...");
  const { fetchArchive, ensureHelia, destroyHelia } = await fetchChunkPromise;
  destroyHeliaFn = destroyHelia;
  await ensureHelia();
  log.warn(`[dot.li app] Helia P2P ready (${elapsed(T0)})`);
  let result = await fetchArchive(cid, showStatus);
  log.warn(`[dot.li app] Content fetched → ${result.type} (${elapsed(T0)})`);

  // Decrypt if the fetched content is an encrypted blob
  if (result.type === "single") {
    const decryptedFiles = await decryptIfNeeded(result.content, cid);
    if (decryptedFiles !== null) {
      log.warn(`[dot.li app] Content decrypted (${elapsed(T0)})`);
      result = { type: "archive", files: decryptedFiles };
    }
  }

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
      log.warn(
        `[dot.li app] Relay mode: archive stored in SW (${elapsed(T0)})`,
      );
      const indexHtml = result.files["index.html"] as Uint8Array | undefined;
      if (indexHtml) {
        html = new TextDecoder().decode(indexHtml);
      }
    }

    if (html !== null) {
      html = await maybeInjectSandboxChecker(html);
      log.warn(
        `[dot.li app] Relay mode: writing content into window (${elapsed(T0)})`,
      );
      notifyLoadingDone();
      performance.mark("dotli:app:end");
      stopApp();
      document.open();
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional: document.write replaces the page with dApp content to eliminate triple iframe nesting
      document.write(html);
      document.close();
      return;
    }
  }

  // Render in sub-iframe (standalone mode or archive fallback)
  showStatus("Rendering...");
  const stopRender = m.timer(S.APP_RENDER);
  const { renderArchive, renderContent } = await renderChunkPromise;
  if (result.type === "archive") {
    await renderArchive(result.files, cid, cid);
  } else {
    await renderContent(result.content, cid);
  }
  stopRender();
  notifyLoadingDone();

  performance.mark("dotli:app:end");
  log.warn(`[dot.li app] Done (${elapsed(T0)})`);
  stopApp();
}

// Cleanup on page unload
window.addEventListener("beforeunload", () => {
  if (destroyHeliaFn) {
    void destroyHeliaFn();
  }
});

function run(): void {
  void main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    showError("Failed to load content", message, () => {
      // Restore the loading UI and re-run main
      const app = document.getElementById("app") ?? document.body;
      app.innerHTML = `
        <div class="loading">
          <h1>dot.li</h1>
          <div class="spinner"></div>
          <p id="status">Retrying...</p>
        </div>
      `;
      run();
    });
  });
}

run();
