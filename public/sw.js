// dot.li — Service Worker for serving multi-file SPA archives
// v6 — fix MIME type for directory-matched index.html + inject base/replaceState
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

// ── IndexedDB persistence ─────────────────────────────────

const DB_NAME = "dotli-sw";
const DB_VERSION = 1;
const STORE_NAME = "archives";

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "domain" });
      }
    };
  });
}

async function saveArchiveToDB(entry) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(entry);
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (error) {
    console.error("Failed to save archive to IndexedDB:", error);
  }
}

async function loadArchiveFromDBByDomain(domain) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(domain);
    const result = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return result || null;
  } catch (error) {
    console.error("Failed to load archive from IndexedDB:", error);
    return null;
  }
}

async function loadArchivesFromDB() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).getAll();
    const result = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return result;
  } catch (error) {
    console.error("Failed to load archives from IndexedDB:", error);
    return [];
  }
}

// In-memory archive cache keyed by domain: { domain, cid, files }
const archiveCache = new Map();
// Active archive for serving fetch requests
let archive = null;

// Activate immediately
self.addEventListener("install", () => {
  self.skipWaiting();
});

// Restore archives from IndexedDB on activation
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const archives = await loadArchivesFromDB();
        for (const entry of archives) {
          if (entry.domain && entry.cid && entry.files) {
            archiveCache.set(entry.domain, entry);
          }
        }
        console.log(`Restored ${archives.length} archive(s) from IndexedDB`);
      } catch (err) {
        console.error("Failed to restore archives from IndexedDB:", err);
      }
      await self.clients.claim();
    })(),
  );
});

// Handle messages from main thread
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SW_CLAIM_EVENT") {
    self.clients.claim();
    return;
  }

  if (event.data && event.data.type === "SET_ARCHIVE") {
    archive = event.data.files; // { path: ArrayBuffer }
    // Cache by domain if provided (in-memory + IndexedDB)
    if (event.data.domain && event.data.cid) {
      const entry = {
        domain: event.data.domain,
        cid: event.data.cid,
        files: event.data.files,
      };
      archiveCache.set(event.data.domain, entry);
      saveArchiveToDB(entry);
    }
    // Notify sender that archive is loaded
    if (event.source) {
      event.source.postMessage({ type: "ARCHIVE_READY" });
    }
  }

  if (event.data && event.data.type === "SW_CACHE_LOOKUP_EVENT") {
    const { domain } = event.data;

    // Check in-memory first
    const cached = archiveCache.get(domain);
    if (cached) {
      for (const port of event.ports) {
        port.postMessage({
          found: true,
          cid: cached.cid,
          files: cached.files,
        });
      }
      return;
    }

    // Fall back to IndexedDB
    loadArchiveFromDBByDomain(domain)
      .then((entry) => {
        if (entry && entry.cid && entry.files) {
          // Restore to in-memory cache
          archiveCache.set(domain, entry);
        }
        for (const port of event.ports) {
          port.postMessage({
            found: !!entry,
            cid: entry?.cid ?? null,
            files: entry?.files ?? null,
          });
        }
      })
      .catch(() => {
        for (const port of event.ports) {
          port.postMessage({ found: false, cid: null, files: null });
        }
      });
  }
});

// Intercept fetch requests for archive files
self.addEventListener("fetch", (event) => {
  if (!archive) return;

  const url = new URL(event.request.url);

  // Only intercept same-origin requests
  if (url.origin !== self.location.origin) return;

  // Never intercept top-level navigations outside /dotli-app/
  if (
    event.request.mode === "navigate" &&
    !url.pathname.startsWith("/dotli-app/")
  ) {
    return;
  }

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
    if (content) {
      filePath = withIndex;
    }
    // Try pathindex.html (no slash)
    if (!content && filePath) {
      const noSlash = filePath + "index.html";
      content = archive[noSlash];
      if (content) {
        filePath = noSlash;
      }
    }
  }

  // Root request
  if (!content && (filePath === "" || filePath === "/")) {
    content = archive["index.html"];
    if (content) {
      filePath = "index.html";
    }
  }

  if (content) {
    const mime = getMimeType(filePath);

    // For HTML files served at a non-root path, inject <base> + replaceState
    // so relative assets resolve via /dotli-app/ and the dApp router sees clean paths
    if (
      mime === "text/html" &&
      pathname !== "/dotli-app/index.html" &&
      pathname !== "/dotli-app/"
    ) {
      const html = new TextDecoder().decode(content);
      const base = "/dotli-app/";
      const stripPrefix = `<script>if(location.pathname.startsWith('/dotli-app')){history.replaceState(null,'',(location.pathname.slice('/dotli-app'.length)||'/')+location.search+location.hash)}</script>`;
      const injected = html.replace(
        "<head>",
        `<head><base href="${base}">${stripPrefix}`,
      );
      return new Response(new TextEncoder().encode(injected), {
        status: 200,
        headers: {
          "Content-Type": mime,
          "Cache-Control": "no-cache",
        },
      });
    }

    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Cache-Control": "no-cache",
      },
    });
  }

  // SPA fallback: serve index.html for non-asset paths (client-side routing)
  if (!hasExtension(filePath) && archive["index.html"]) {
    const html = new TextDecoder().decode(archive["index.html"]);
    const base = "/dotli-app/";
    const stripPrefix = `<script>if(location.pathname.startsWith('/dotli-app')){history.replaceState(null,'',(location.pathname.slice('/dotli-app'.length)||'/')+location.search+location.hash)}</script>`;
    const injected = html.replace(
      "<head>",
      `<head><base href="${base}">${stripPrefix}`,
    );
    return new Response(new TextEncoder().encode(injected), {
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
