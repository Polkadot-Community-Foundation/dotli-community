// dot.li — Shared IndexedDB connection
//
// Single "dotli" database with stores for CID cache and smoldot chain data.
// Pre-opened during HTML parse via an inline <script> (window.__dotliDb).

declare global {
  interface Window {
    __dotliDb?: Promise<IDBDatabase>;
  }
}

const DB_NAME = "dotli";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openFresh(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("cids")) {
        db.createObjectStore("cids", { keyPath: "label" });
      }
      if (!db.objectStoreNames.contains("chains")) {
        db.createObjectStore("chains", { keyPath: "chain" });
      }
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(new Error("Failed to open dotli DB"));
    };
  });
}

/**
 * Get the shared database connection.
 * Reuses the pre-opened connection from window.__dotliDb if available.
 */
export function getDb(): Promise<IDBDatabase> {
  if (dbPromise !== null) {
    return dbPromise;
  }

  // Pick up the pre-opened connection from the inline HTML script
  if (typeof window !== "undefined" && window.__dotliDb) {
    dbPromise = window.__dotliDb.catch(() => openFresh());
  } else {
    dbPromise = openFresh();
  }

  // Reset on close so we re-open on next access
  void dbPromise
    .then((db) => {
      db.onclose = () => {
        dbPromise = null;
      };
    })
    .catch(() => {
      /* fire-and-forget */
    });

  return dbPromise;
}
