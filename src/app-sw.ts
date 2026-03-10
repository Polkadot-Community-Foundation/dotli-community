// dot.li — App Service Worker
//
// Archive serving only — no smoldot, no chain sync.
// Runs on cid.app.dot.li to serve multi-file SPA archives from in-memory/IndexedDB cache.

/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { getMimeType } from "./mime";
import { SW_ARCHIVE_CACHE_MAX } from "./config";

// ── Base path (derived at runtime from SW script location) ────
const BASE = self.location.pathname.replace(/(?:src\/)?app-sw\.[jt]s$/, "");
const DOTLI_APP_PREFIX = `${BASE}dotli-app/`;

// ── Archive Serving ──────────────────────────────────────────

function hasExtension(path: string): boolean {
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");
  return lastDot > lastSlash;
}

// ── IndexedDB archive persistence (pooled connection) ─────────

const ARCHIVE_DB_NAME = "dotli-sw";
const ARCHIVE_DB_VERSION = 1;
const ARCHIVE_STORE = "archives";

interface ArchiveEntry {
  domain?: string;
  cid?: string;
  files?: Record<string, ArrayBuffer>;
}

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

let archivePacked: ArrayBuffer | null = null;
let archiveFileIndex: Map<string, { o: number; l: number }> | null = null;
let archiveLegacy: Record<string, ArrayBuffer | undefined> | null = null;

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
    const packed = data.packed as ArrayBuffer | undefined;
    const idx = data.index as { p: string; o: number; l: number }[] | undefined;

    if (packed !== undefined && idx !== undefined) {
      archivePacked = packed;
      archiveFileIndex = new Map(idx.map((e) => [e.p, { o: e.o, l: e.l }]));
      archiveLegacy = null;
    } else {
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
    !url.pathname.startsWith(DOTLI_APP_PREFIX)
  ) {
    return;
  }

  if (
    url.pathname === BASE ||
    url.pathname === BASE.slice(0, -1) ||
    url.pathname === `${BASE}app-sw.js` ||
    url.pathname.startsWith(`${BASE}src/`) ||
    url.pathname.startsWith(`${BASE}node_modules/`) ||
    url.pathname.startsWith(`${BASE}@`)
  ) {
    return;
  }

  const result = lookupArchive(url.pathname);
  if (result !== null) {
    event.respondWith(result);
  }
});

function lookupArchive(pathname: string): Response | null {
  let filePath = pathname.startsWith(DOTLI_APP_PREFIX)
    ? pathname.slice(DOTLI_APP_PREFIX.length)
    : pathname.startsWith(BASE)
      ? pathname.slice(BASE.length)
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
      pathname !== `${DOTLI_APP_PREFIX}index.html` &&
      pathname !== DOTLI_APP_PREFIX
    ) {
      return makeHtmlResponse(content, mime);
    }
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
  const prefixNoSlash = DOTLI_APP_PREFIX.slice(0, -1);
  const prefixLen = String(prefixNoSlash.length);
  const stripPrefix = `<script>if(location.pathname.startsWith('${prefixNoSlash}')){history.replaceState(null,'',(location.pathname.slice(${prefixLen})||'/')+location.search+location.hash)}</script>`;
  const injected = html.replace(
    "<head>",
    `<head><base href="${DOTLI_APP_PREFIX}">${stripPrefix}`,
  );
  return new Response(new TextEncoder().encode(injected), {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Cache-Control": "no-cache",
    },
  });
}
