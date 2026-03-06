// dot.li — Sandboxed content rendering
//
// Takes fetched content and renders it in a sandboxed <iframe>.
// The iframe isolates the resolved site from the viewer's origin.
// Uses blob URLs so the container bridge can communicate via postMessage.

import type { ArchiveFiles } from "./archive";

// Eagerly load the container bridge chunk — starts downloading when
// the render chunk is imported, so it's ready by the time we need it.
const containerChunkPromise = import("./container");
void containerChunkPromise.catch(() => {
  /* fire-and-forget */
});

const app = document.getElementById("app") ?? document.body;

let currentDispose: (() => void) | null = null;
let currentBlobUrl: string | null = null;

/**
 * Capture deep link path (pathname + search + hash) to forward into the iframe.
 */
function getDeepPath(): string {
  const { pathname, search, hash } = window.location;
  return pathname === "/" ? "" : pathname + search + hash;
}

/**
 * Render single-file HTML content in a sandboxed iframe with host-container bridge.
 *
 * Creates a blob URL from the content and passes it to createIframeProvider,
 * which sets iframe.src itself. The container bridge enables postMessage
 * communication between the SPA and dot.li.
 */
export async function renderContent(
  content: Uint8Array,
  label: string,
): Promise<void> {
  cleanup();

  const html = new TextDecoder().decode(content);

  // Create a blob URL so the iframe has a proper origin for postMessage
  const blob = new Blob([html], { type: "text/html" });
  let blobUrl = URL.createObjectURL(blob);
  currentBlobUrl = blobUrl;

  // Append hash fragment to blob URL so the dApp can read it
  const deepPath = getDeepPath();
  if (deepPath !== "") {
    const hashIndex = deepPath.indexOf("#");
    if (hashIndex !== -1) {
      blobUrl += deepPath.slice(hashIndex);
    }
  }

  await renderIframe(blobUrl, label);
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
  cid?: string,
): Promise<void> {
  cleanup();

  const sw = navigator.serviceWorker.controller;
  if (sw === null) {
    // SW not ready — fall back to rendering index.html as single file
    const indexHtml = files["index.html"] as Uint8Array | undefined;
    if (indexHtml !== undefined) {
      await renderContent(indexHtml, label);
      return;
    }
    throw new Error("No service worker and no index.html in archive");
  }

  // Pack all files into a single buffer + offset index.
  // Transfers 1 Transferable instead of N, reducing structured clone overhead
  // from O(n_files) to O(1).
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

  // Wait for the SW to confirm it has received the archive
  const archiveReady = new Promise<void>((resolve) => {
    const handler = (evt: MessageEvent): void => {
      if ((evt.data as { type?: string } | null)?.type === "ARCHIVE_READY") {
        navigator.serviceWorker.removeEventListener("message", handler);
        resolve();
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
  });

  // Send packed archive to the SW (single Transferable)
  sw.postMessage({ type: "SET_ARCHIVE", packed, index, domain: label, cid }, [
    packed,
  ]);

  // Wait for the SW to process the message (replaces 50ms setTimeout)
  await archiveReady;

  // Load the iframe from the SW scope, forwarding the deep link path
  const deepPath = getDeepPath();
  const swUrl =
    deepPath !== ""
      ? `${window.location.origin}/dotli-app${deepPath}`
      : `${window.location.origin}/dotli-app/index.html`;
  await renderIframe(swUrl, label);
}

// Pre-created iframe element — call prepareIframe() early to avoid
// DOM creation overhead during the render-critical path.
let preparedIframe: HTMLIFrameElement | null = null;

/**
 * Pre-create the iframe element and append it (hidden) to the DOM.
 * Call this during the fetch/resolve phase so the iframe is ready instantly.
 */
export function prepareIframe(): void {
  if (preparedIframe) {
    return;
  }
  const iframe = document.createElement("iframe");
  // TODO(security): allow-scripts + allow-same-origin together allows sandbox
  // escape. This is intentional — the container bridge (container.ts) needs
  // same-origin access to communicate with the parent frame via postMessage
  // and to access SW-served resources. Without allow-same-origin the SW cannot
  // intercept iframe fetches, breaking archive serving entirely.
  iframe.sandbox.add("allow-scripts", "allow-same-origin");
  iframe.style.cssText =
    "position:fixed;top:40px;left:0;width:100%;height:calc(100vh - 40px);border:none;margin:0;padding:0;visibility:hidden;";
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
  app.appendChild(iframe);
  preparedIframe = iframe;
}

async function renderIframe(url: string, label: string): Promise<void> {
  let iframe: HTMLIFrameElement;
  if (preparedIframe) {
    // Detach before clearing, then re-append
    iframe = preparedIframe;
    preparedIframe = null;
    iframe.remove();
    app.innerHTML = "";
    iframe.style.visibility = "visible";
    app.appendChild(iframe);
  } else {
    app.innerHTML = "";
    iframe = document.createElement("iframe");
    iframe.sandbox.add("allow-scripts", "allow-same-origin");
    iframe.style.cssText =
      "position:fixed;top:40px;left:0;width:100%;height:calc(100vh - 40px);border:none;margin:0;padding:0;";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    app.appendChild(iframe);
  }

  const { setupContainer } = await containerChunkPromise;
  currentDispose = setupContainer(iframe, url, label);

  // Mirror the iframe's document.title to the parent page.
  // SPAs change titles dynamically, so we observe <title> mutations.
  const fallbackTitle = `${label}.dot`;
  iframe.addEventListener("load", () => {
    try {
      const doc = iframe.contentDocument;
      if (!doc) {
        return;
      }
      const applyTitle = (): void => {
        document.title = doc.title || fallbackTitle;
      };
      applyTitle();
      const titleEl = doc.querySelector("title");
      if (titleEl) {
        new MutationObserver(applyTitle).observe(titleEl, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
    } catch {
      document.title = fallbackTitle;
    }
  });
}

function cleanup(): void {
  if (currentDispose) {
    currentDispose();
    currentDispose = null;
  }
  if (currentBlobUrl !== null) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
  if (preparedIframe) {
    preparedIframe.remove();
    preparedIframe = null;
  }
}
