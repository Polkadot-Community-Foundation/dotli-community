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

import { handleConnect, handleStatus, ensureSmoldot } from "./sw-smoldot";
import { getMimeType } from "./mime";
import { SW_ARCHIVE_CACHE_MAX, TIMEOUTS } from "./config";

// ── Archive Serving (ported from public/sw.js) ───────────────

function hasExtension(path: string): boolean {
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");
  return lastDot > lastSlash;
}

// ── IndexedDB archive persistence (pooled connection) ─────────

const ARCHIVE_DB_NAME = "dotli-sw";
const ARCHIVE_DB_VERSION = 1;
const ARCHIVE_STORE = "archives";

// Fields are optional because IndexedDB data may be incomplete/corrupt
interface ArchiveEntry {
  domain?: string;
  cid?: string;
  files?: Record<string, ArrayBuffer>;
}

// Pooled IDB connection — reused across save/load calls
let archiveDbPromise: Promise<IDBDatabase> | null = null;

function getArchiveDB(): Promise<IDBDatabase> {
  if (archiveDbPromise !== null) {
    return archiveDbPromise;
  }
  archiveDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(ARCHIVE_DB_NAME, ARCHIVE_DB_VERSION);
    request.onerror = () => {
      archiveDbPromise = null;
      reject(new Error("Failed to open archive DB"));
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => {
        archiveDbPromise = null;
      };
      resolve(db);
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ARCHIVE_STORE)) {
        db.createObjectStore(ARCHIVE_STORE, { keyPath: "domain" });
      }
    };
  });
  return archiveDbPromise;
}

async function saveArchiveToDB(entry: {
  domain: string;
  cid: string;
  files: Record<string, ArrayBuffer>;
}): Promise<void> {
  try {
    const db = await getArchiveDB();
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
  } catch (error) {
    console.error("Failed to save archive to IndexedDB:", error);
  }
}

async function loadArchiveFromDBByDomain(
  domain: string,
): Promise<ArchiveEntry | null> {
  try {
    const db = await getArchiveDB();
    const tx = db.transaction(ARCHIVE_STORE, "readonly");
    const request = tx.objectStore(ARCHIVE_STORE).get(domain);
    return await new Promise<ArchiveEntry | null>((resolve, reject) => {
      request.onsuccess = () => {
        resolve((request.result as ArchiveEntry | undefined) ?? null);
      };
      request.onerror = () => {
        reject(new Error("Failed to load archive"));
      };
    });
  } catch (error) {
    console.error("Failed to load archive from IndexedDB:", error);
    return null;
  }
}

// ── Archive storage ──────────────────────────────────────────
// Two formats supported:
// 1. Packed: single ArrayBuffer + index map (from SET_ARCHIVE, zero-copy serving)
// 2. Legacy: Record<string, ArrayBuffer> (from IDB cache on SW_CACHE_LOOKUP_EVENT)

let archivePacked: ArrayBuffer | null = null;
let archiveFileIndex: Map<string, { o: number; l: number }> | null = null;
let archiveLegacy: Record<string, ArrayBuffer | undefined> | null = null;

// In-memory archive cache keyed by domain (populated lazily on lookup).
// LRU eviction: Map iteration order tracks insertion; re-inserting on access
// moves the entry to the end, so the first key is always the least-recently-used.
const archiveCache = new Map<string, ArchiveEntry>();

function archiveCacheSet(key: string, value: ArchiveEntry): void {
  archiveCache.delete(key);
  archiveCache.set(key, value);
  if (archiveCache.size > SW_ARCHIVE_CACHE_MAX) {
    const oldest = archiveCache.keys().next().value;
    if (oldest !== undefined) {
      archiveCache.delete(oldest);
    }
  }
}

function archiveCacheGet(key: string): ArchiveEntry | undefined {
  const entry = archiveCache.get(key);
  if (entry === undefined) {
    return undefined;
  }
  // Move to end (most-recently-used)
  archiveCache.delete(key);
  archiveCache.set(key, entry);
  return entry;
}

function hasArchive(): boolean {
  return archivePacked !== null || archiveLegacy !== null;
}

function getFile(path: string): ArrayBuffer | Uint8Array | undefined {
  if (archiveFileIndex !== null && archivePacked !== null) {
    const entry = archiveFileIndex.get(path);
    if (entry !== undefined) {
      return new Uint8Array(archivePacked, entry.o, entry.l);
    }
    return undefined;
  }
  return archiveLegacy?.[path];
}

// ── SW Lifecycle ─────────────────────────────────────────────

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Archives are loaded lazily on SW_CACHE_LOOKUP_EVENT (per-domain),
  // so activation stays fast regardless of how many domains are cached.
  event.waitUntil(self.clients.claim());
  // Start smoldot in the background (non-blocking) — on subsequent visits
  // to the same origin, smoldot will already be synced and ready.
  // Skip in dev mode: dynamic imports are disallowed in SW scope;
  // production builds inline everything so this works fine.
  if (!import.meta.env.DEV) {
    setTimeout(() => {
      void ensureSmoldot().catch(() => {
        /* fire-and-forget */
      });
    }, TIMEOUTS.SW_SMOLDOT_INIT_DELAY);
  }
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
    const packed = data.packed as ArrayBuffer | undefined;
    const idx = data.index as { p: string; o: number; l: number }[] | undefined;

    if (packed !== undefined && idx !== undefined) {
      // Packed format: single buffer + index (zero-copy serving via Uint8Array views)
      archivePacked = packed;
      archiveFileIndex = new Map(idx.map((e) => [e.p, { o: e.o, l: e.l }]));
      archiveLegacy = null;
    } else {
      // Legacy format: individual files
      archiveLegacy = data.files as Record<string, ArrayBuffer | undefined>;
      archivePacked = null;
      archiveFileIndex = null;
    }

    const domain = data.domain as string | undefined;
    const cid = data.cid as string | undefined;
    if (
      domain !== undefined &&
      domain !== "" &&
      cid !== undefined &&
      cid !== ""
    ) {
      if (packed !== undefined && idx !== undefined) {
        // Unpack for IDB persistence in background (non-blocking)
        const p = packed;
        const i = idx;
        const d = domain;
        const c = cid;
        setTimeout(() => {
          const files: Record<string, ArrayBuffer> = {};
          for (const entry of i) {
            files[entry.p] = p.slice(entry.o, entry.o + entry.l);
          }
          const archiveEntry = { domain: d, cid: c, files };
          archiveCacheSet(d, archiveEntry);
          void saveArchiveToDB(archiveEntry);
        }, 0);
      } else {
        const files = (archiveLegacy ?? {}) as Record<string, ArrayBuffer>;
        const entry = { domain, cid, files };
        archiveCacheSet(domain, entry);
        void saveArchiveToDB(entry);
      }
    }
    if (event.source) {
      (event.source as Client).postMessage({ type: "ARCHIVE_READY" });
    }
    return;
  }

  if (data.type === "SW_CACHE_LOOKUP_EVENT") {
    const domain = data.domain as string;
    const cached = archiveCacheGet(domain);
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
          archiveCacheSet(domain, entry);
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
  if (!hasArchive()) {
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

  const result = lookupArchive(url.pathname);
  if (result !== null) {
    event.respondWith(result);
  }
});

function lookupArchive(pathname: string): Response | null {
  let filePath = pathname.startsWith("/dotli-app/")
    ? pathname.slice("/dotli-app/".length)
    : pathname.slice(1);

  filePath = decodeURIComponent(filePath);

  let content = getFile(filePath);

  if (content === undefined && !hasExtension(filePath)) {
    const withIndex = filePath !== "" ? filePath + "/index.html" : "index.html";
    content = getFile(withIndex);
    if (content !== undefined) {
      filePath = withIndex;
    }
    if (content === undefined && filePath !== "") {
      const noSlash = filePath + "index.html";
      content = getFile(noSlash);
      if (content !== undefined) {
        filePath = noSlash;
      }
    }
  }

  if (content === undefined && (filePath === "" || filePath === "/")) {
    content = getFile("index.html");
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
    // Normalize Uint8Array views to ArrayBuffer for Response constructor
    const body =
      content instanceof Uint8Array
        ? (content.buffer.slice(
            content.byteOffset,
            content.byteOffset + content.byteLength,
          ) as ArrayBuffer)
        : content;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Cache-Control": "no-cache",
      },
    });
  }

  // SPA fallback
  const indexHtml = getFile("index.html");
  if (!hasExtension(filePath) && indexHtml !== undefined) {
    return makeHtmlResponse(indexHtml, "text/html");
  }

  return null;
}

function makeHtmlResponse(
  content: ArrayBuffer | Uint8Array,
  mime: string,
): Response {
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
