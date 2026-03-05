// dot.li — Sandboxed content rendering
//
// Takes fetched content and renders it in a sandboxed <iframe>.
// The iframe isolates the resolved site from the viewer's origin.
// Uses blob URLs so the container bridge can communicate via postMessage.

import { setupContainer } from "./container";
import type { ArchiveFiles } from "./archive";

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
export function renderContent(content: Uint8Array, label: string): void {
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
  cid?: string,
): Promise<void> {
  cleanup();

  const sw = navigator.serviceWorker.controller;
  if (sw === null) {
    // SW not ready — fall back to rendering index.html as single file
    const indexHtml = files["index.html"] as Uint8Array | undefined;
    if (indexHtml !== undefined) {
      renderContent(indexHtml, label);
      return;
    }
    throw new Error("No service worker and no index.html in archive");
  }

  // Transfer underlying ArrayBuffers directly (zero-copy when possible)
  const transferableFiles: Record<string, ArrayBuffer> = {};
  const transferList: ArrayBuffer[] = [];
  for (const [filePath, data] of Object.entries(files)) {
    const buf = data.buffer as ArrayBuffer;
    // If the Uint8Array is a view over a larger or shared buffer, copy it
    if (data.byteOffset !== 0 || data.byteLength !== buf.byteLength) {
      const copy = new ArrayBuffer(data.byteLength);
      new Uint8Array(copy).set(data);
      transferableFiles[filePath] = copy;
      transferList.push(copy);
    } else {
      transferableFiles[filePath] = buf;
      transferList.push(buf);
    }
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

  // Send archive to the SW (include domain + cid for caching)
  sw.postMessage(
    { type: "SET_ARCHIVE", files: transferableFiles, domain: label, cid },
    transferList,
  );

  // Wait for the SW to process the message (replaces 50ms setTimeout)
  await archiveReady;

  // Load the iframe from the SW scope, forwarding the deep link path
  const deepPath = getDeepPath();
  const swUrl =
    deepPath !== ""
      ? `${window.location.origin}/dotli-app${deepPath}`
      : `${window.location.origin}/dotli-app/index.html`;
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
  if (currentBlobUrl !== null) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
}
