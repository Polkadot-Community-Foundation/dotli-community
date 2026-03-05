// dot.li — Service Worker
//
// Combines two responsibilities:
// 1. Archive serving: serves multi-file SPA archives from in-memory/IndexedDB cache
// 2. Smoldot management: runs smoldot light client for chain resolution persistence
//
// This SW is built as a module (type: 'module') by Vite and registered
// with { type: 'module' } in main.ts.

/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { handleConnect, handleStatus } from "./sw-smoldot";

// ── Archive Serving (ported from public/sw.js) ───────────────

const MIME_TYPES: Record<string, string> = {
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

function getMimeType(path: string): string {
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) {
    return "application/octet-stream";
  }
  const ext = path.substring(lastDot + 1).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function hasExtension(path: string): boolean {
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");
  return lastDot > lastSlash;
}

// ── IndexedDB archive persistence ────────────────────────────

const ARCHIVE_DB_NAME = "dotli-sw";
const ARCHIVE_DB_VERSION = 1;
const ARCHIVE_STORE = "archives";

// Fields are optional because IndexedDB data may be incomplete/corrupt
interface ArchiveEntry {
  domain?: string;
  cid?: string;
  files?: Record<string, ArrayBuffer>;
}

function openArchiveDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ARCHIVE_DB_NAME, ARCHIVE_DB_VERSION);
    request.onerror = () => {
      reject(new Error("Failed to open archive DB"));
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ARCHIVE_STORE)) {
        db.createObjectStore(ARCHIVE_STORE, { keyPath: "domain" });
      }
    };
  });
}

async function saveArchiveToDB(entry: {
  domain: string;
  cid: string;
  files: Record<string, ArrayBuffer>;
}): Promise<void> {
  try {
    const db = await openArchiveDB();
    const tx = db.transaction(ARCHIVE_STORE, "readwrite");
    tx.objectStore(ARCHIVE_STORE).put(entry);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(new Error("Failed to save archive"));
      };
    });
    db.close();
  } catch (error) {
    console.error("Failed to save archive to IndexedDB:", error);
  }
}

async function loadArchiveFromDBByDomain(
  domain: string,
): Promise<ArchiveEntry | null> {
  try {
    const db = await openArchiveDB();
    const tx = db.transaction(ARCHIVE_STORE, "readonly");
    const request = tx.objectStore(ARCHIVE_STORE).get(domain);
    const result = await new Promise<ArchiveEntry | null>((resolve, reject) => {
      request.onsuccess = () => {
        resolve((request.result as ArchiveEntry | undefined) ?? null);
      };
      request.onerror = () => {
        reject(new Error("Failed to load archive"));
      };
    });
    db.close();
    return result;
  } catch (error) {
    console.error("Failed to load archive from IndexedDB:", error);
    return null;
  }
}

// In-memory archive cache keyed by domain (populated lazily on lookup)
const archiveCache = new Map<string, ArchiveEntry>();
// Active archive for serving fetch requests
let archive: Record<string, ArrayBuffer | undefined> | null = null;

// ── SW Lifecycle ─────────────────────────────────────────────

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Archives are loaded lazily on SW_CACHE_LOOKUP_EVENT (per-domain),
  // so activation stays fast regardless of how many domains are cached.
  event.waitUntil(self.clients.claim());
});

// ── Message Handling ─────────────────────────────────────────

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: string; [key: string]: unknown } | null;
  if (data?.type === undefined || data.type === "") {
    return;
  }

  if (data.type === "SW_CLAIM_EVENT") {
    void self.clients.claim();
    return;
  }

  if (data.type === "SET_ARCHIVE") {
    archive = data.files as Record<string, ArrayBuffer | undefined>;
    const domain = data.domain as string | undefined;
    const cid = data.cid as string | undefined;
    if (
      domain !== undefined &&
      domain !== "" &&
      cid !== undefined &&
      cid !== ""
    ) {
      const files = archive as Record<string, ArrayBuffer>;
      const entry = { domain, cid, files };
      archiveCache.set(domain, entry);
      void saveArchiveToDB(entry);
    }
    if (event.source) {
      (event.source as Client).postMessage({ type: "ARCHIVE_READY" });
    }
    return;
  }

  if (data.type === "SW_CACHE_LOOKUP_EVENT") {
    const domain = data.domain as string;
    const cached = archiveCache.get(domain);
    if (cached !== undefined) {
      for (const port of event.ports) {
        port.postMessage({
          found: true,
          cid: cached.cid,
          files: cached.files,
        });
      }
      return;
    }
    void loadArchiveFromDBByDomain(domain)
      .then((entry) => {
        if (entry !== null && entry.cid !== "" && entry.files !== undefined) {
          archiveCache.set(domain, entry);
        }
        for (const port of event.ports) {
          port.postMessage({
            found: entry !== null,
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
    return;
  }

  if (data.type === "SMOLDOT_STATUS") {
    if (event.ports.length > 0) {
      handleStatus(event.ports[0]);
    }
    return;
  }

  if (data.type === "SMOLDOT_CONNECT") {
    if (event.ports.length > 0) {
      void handleConnect(event.ports[0]);
    }
    return;
  }
});

// ── Fetch Interception (archive serving) ─────────────────────

self.addEventListener("fetch", (event: FetchEvent) => {
  if (archive === null) {
    return;
  }

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

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

  const result = lookupArchive(url.pathname, archive);
  if (result !== null) {
    event.respondWith(result);
  }
});

function lookupArchive(
  pathname: string,
  files: Record<string, ArrayBuffer | undefined>,
): Response | null {
  let filePath = pathname.startsWith("/dotli-app/")
    ? pathname.slice("/dotli-app/".length)
    : pathname.slice(1);

  filePath = decodeURIComponent(filePath);

  let content: ArrayBuffer | undefined = files[filePath];

  if (content === undefined && !hasExtension(filePath)) {
    const withIndex = filePath !== "" ? filePath + "/index.html" : "index.html";
    content = files[withIndex];
    if (content !== undefined) {
      filePath = withIndex;
    }
    if (content === undefined && filePath !== "") {
      const noSlash = filePath + "index.html";
      content = files[noSlash];
      if (content !== undefined) {
        filePath = noSlash;
      }
    }
  }

  if (content === undefined && (filePath === "" || filePath === "/")) {
    content = files["index.html"];
    if (content !== undefined) {
      filePath = "index.html";
    }
  }

  if (content !== undefined) {
    const mime = getMimeType(filePath);
    if (
      mime === "text/html" &&
      pathname !== "/dotli-app/index.html" &&
      pathname !== "/dotli-app/"
    ) {
      return makeHtmlResponse(content, mime);
    }
    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Cache-Control": "no-cache",
      },
    });
  }

  // SPA fallback
  const indexHtml = files["index.html"];
  if (!hasExtension(filePath) && indexHtml !== undefined) {
    return makeHtmlResponse(indexHtml, "text/html");
  }

  return null;
}

function makeHtmlResponse(content: ArrayBuffer, mime: string): Response {
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
