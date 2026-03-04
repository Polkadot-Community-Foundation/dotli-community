// dot.li — Service Worker for serving multi-file SPA archives
//
// Receives an archive (file map) from the main thread via postMessage,
// then intercepts fetch requests and serves files from the in-memory map.
// Handles both relative paths (/dotli-app/main.js) and absolute paths (/_next/static/...).

const MIME_TYPES = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  xml: "application/xml",
  txt: "text/plain",
  pdf: "application/pdf",
};

function getMimeType(path) {
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return "application/octet-stream";
  const ext = path.substring(lastDot + 1).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

function hasExtension(path) {
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");
  return lastDot > lastSlash;
}

// In-memory file archive: { path: ArrayBuffer }
let archive = null;

// Activate immediately
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Handle messages from main thread
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SW_CLAIM_EVENT") {
    self.clients.claim();
    return;
  }

  if (event.data && event.data.type === "SET_ARCHIVE") {
    archive = event.data.files; // { path: ArrayBuffer }
    // Notify sender that archive is loaded
    if (event.source) {
      event.source.postMessage({ type: "ARCHIVE_READY" });
    }
  }
});

// Intercept fetch requests for archive files
self.addEventListener("fetch", (event) => {
  if (!archive) return; // No archive loaded, let request pass through

  const url = new URL(event.request.url);

  // Only intercept same-origin requests
  if (url.origin !== self.location.origin) return;

  // Never intercept these host app paths
  if (
    url.pathname === "/" ||
    url.pathname === "/sw.js" ||
    url.pathname.startsWith("/src/") ||
    url.pathname.startsWith("/node_modules/") ||
    url.pathname.startsWith("/@")
  ) {
    return;
  }

  // Try to serve from archive — only intercept if the file is actually in the archive
  const result = lookupArchive(url.pathname);
  if (result) {
    event.respondWith(result);
  }
});

function lookupArchive(pathname) {
  // Strip leading slash and /dotli-app/ prefix if present
  let filePath = pathname.startsWith("/dotli-app/")
    ? pathname.slice("/dotli-app/".length)
    : pathname.slice(1); // strip leading /

  // Decode URI components
  filePath = decodeURIComponent(filePath);

  // Try exact match
  let content = archive[filePath];

  // Handle directory requests → serve index.html
  if (!content && !hasExtension(filePath)) {
    // Try path/index.html
    const withIndex = filePath ? filePath + "/index.html" : "index.html";
    content = archive[withIndex];
    // Try pathindex.html (no slash)
    if (!content && filePath) {
      content = archive[filePath + "index.html"];
    }
  }

  // Root request
  if (!content && (filePath === "" || filePath === "/")) {
    content = archive["index.html"];
  }

  if (content) {
    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": getMimeType(filePath || "index.html"),
        "Cache-Control": "no-cache",
      },
    });
  }

  // SPA fallback: serve index.html for non-asset paths (client-side routing)
  if (!hasExtension(filePath) && archive["index.html"]) {
    return new Response(archive["index.html"], {
      status: 200,
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": "no-cache",
      },
    });
  }

  // Not in archive — don't intercept, let the browser handle it
  return null;
}
