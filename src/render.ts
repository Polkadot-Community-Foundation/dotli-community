// dot.li — Sandboxed content rendering
//
// Takes fetched content and renders it in a sandboxed <iframe>.
// The iframe isolates the resolved site from the viewer's origin.
// Uses blob URLs so the container bridge can communicate via postMessage.

import { setupContainer } from "./container";
import type { ArchiveFiles } from "./archive";

const app = document.getElementById("app")!;

let currentDispose: (() => void) | null = null;
let currentBlobUrl: string | null = null;

/**
 * Render single-file HTML content in a sandboxed iframe with host-container bridge.
 *
 * Creates a blob URL from the content and passes it to createIframeProvider,
 * which sets iframe.src itself. The container bridge enables postMessage
 * communication between the SPA and dot.li.
 */
export function renderContent(content: Uint8Array, label: string): void {
  cleanup();

  const html = new TextDecoder().decode(content);

  // Create a blob URL so the iframe has a proper origin for postMessage
  const blob = new Blob([html], { type: "text/html" });
  const blobUrl = URL.createObjectURL(blob);
  currentBlobUrl = blobUrl;

  renderIframe(blobUrl, label);
}

/**
 * Render a multi-file SPA archive via the Service Worker.
 *
 * Sends the file map to the SW, then loads the iframe from the SW scope.
 * The SW intercepts all fetch requests and serves files from the archive.
 */
export async function renderArchive(
  files: ArchiveFiles,
  label: string,
): Promise<void> {
  cleanup();

  const sw = navigator.serviceWorker?.controller;
  if (!sw) {
    // SW not ready — fall back to rendering index.html as single file
    const indexHtml = files["index.html"];
    if (indexHtml) {
      return renderContent(indexHtml, label);
    }
    throw new Error("No service worker and no index.html in archive");
  }

  // Convert Uint8Arrays to ArrayBuffers for structured clone transfer
  const transferableFiles: Record<string, ArrayBuffer> = {};
  for (const [path, data] of Object.entries(files)) {
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(data);
    transferableFiles[path] = copy;
  }

  // Send archive to the SW
  sw.postMessage(
    { type: "SET_ARCHIVE", files: transferableFiles },
    Object.values(transferableFiles),
  );

  // Small delay to let the SW process the message
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Load the iframe from the SW scope
  const swUrl = `${window.location.origin}/dotli-app/index.html`;
  renderIframe(swUrl, label);
}

function renderIframe(url: string, label: string): void {
  app.innerHTML = "";

  const iframe = document.createElement("iframe");
  iframe.sandbox.add("allow-scripts", "allow-same-origin");
  iframe.style.cssText =
    "position:fixed;top:40px;left:0;width:100%;height:calc(100vh - 40px);border:none;margin:0;padding:0;";

  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
  app.appendChild(iframe);

  // Wire up the host-container bridge (sets iframe.src)
  currentDispose = setupContainer(iframe, url, label);
}

function cleanup(): void {
  if (currentDispose) {
    currentDispose();
    currentDispose = null;
  }
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
}

/**
 * Show a status message in the loading UI.
 */
export function showStatus(message: string): void {
  const status = document.getElementById("status");
  if (status) status.textContent = message;
}

/**
 * Show an error state.
 */
export function showError(title: string, detail: string): void {
  app.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 40px);font-family:system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;">
      <div style="max-width:480px;padding:2rem;text-align:center;">
        <h1 style="font-size:1.5rem;color:#fff;margin-bottom:0.75rem;">${title}</h1>
        <p style="color:#888;line-height:1.6;">${detail}</p>
        <div style="margin-top:1.5rem;display:inline-flex;gap:0.5rem;font-size:0.8rem;color:#555;">
          <span style="padding:0.25rem 0.6rem;border:1px solid #222;border-radius:4px;">dot.li</span>
          <span style="padding:0.25rem 0.6rem;border:1px solid #222;border-radius:4px;">dotNS</span>
          <span style="padding:0.25rem 0.6rem;border:1px solid #222;border-radius:4px;">Bulletin</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Show the landing page (no subdomain detected).
 */
export function showLanding(): void {
  app.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 40px);font-family:system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;">
      <div style="max-width:480px;padding:2rem;text-align:center;">
        <h1 style="font-size:1.5rem;color:#fff;margin-bottom:0.75rem;">
          <span style="color:#e6007a;">dot</span>.li
        </h1>
        <p style="color:#888;line-height:1.6;">
          Polkadot Universal Resolver. Visit <code style="color:#aaa;">name.dot.li</code> to resolve a <code style="color:#aaa;">.dot</code> domain.
        </p>
        <div style="margin-top:1.5rem;display:inline-flex;gap:0.5rem;font-size:0.8rem;color:#555;">
          <span style="padding:0.25rem 0.6rem;border:1px solid #222;border-radius:4px;">Trustless</span>
          <span style="padding:0.25rem 0.6rem;border:1px solid #222;border-radius:4px;">Client-side</span>
          <span style="padding:0.25rem 0.6rem;border:1px solid #222;border-radius:4px;">Light client</span>
        </div>
      </div>
    </div>
  `;
}
