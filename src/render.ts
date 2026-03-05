// dot.li — Sandboxed content rendering
//
// Takes fetched content and renders it in a sandboxed <iframe>.
// The iframe isolates the resolved site from the viewer's origin.
// Uses blob URLs so the container bridge can communicate via postMessage.

import type { ArchiveFiles } from "./archive";

// Eagerly load the container bridge chunk — starts downloading when
// the render chunk is imported, so it's ready by the time we need it.
const containerChunkPromise = import("./container");
void containerChunkPromise.catch(Function.prototype as () => void);

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

  // Transfer underlying ArrayBuffers directly to the SW (zero-copy).
  // Archive files from concatBytes() are fresh Uint8Arrays with byteOffset=0,
  // so the fast path (no copy) applies to virtually all files.
  const transferableFiles: Record<string, ArrayBuffer> = {};
  const transferList: ArrayBuffer[] = [];
  for (const [filePath, data] of Object.entries(files)) {
    const buf = data.buffer as ArrayBuffer;
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
