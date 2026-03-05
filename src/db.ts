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

const CHAINS_STORE = "chains";

/**
 * Load a persisted chain database from IndexedDB.
 */
export async function loadChainDb(chain: string): Promise<string | undefined> {
  try {
    const db = await getDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(CHAINS_STORE, "readonly");
      const req = tx.objectStore(CHAINS_STORE).get(chain);
      req.onsuccess = () => {
        resolve((req.result as { content?: string } | undefined)?.content);
      };
      req.onerror = () => {
        resolve(undefined);
      };
    });
  } catch {
    return undefined;
  }
}

/**
 * Persist a chain database to IndexedDB.
 */
export async function saveChainDb(
  chain: string,
  content: string,
): Promise<void> {
  try {
    const db = await getDb();
    const tx = db.transaction(CHAINS_STORE, "readwrite");
    tx.objectStore(CHAINS_STORE).put({ chain, content, ts: Date.now() });
  } catch {
    // Non-critical
  }
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
  void dbPromise.then((db) => {
    db.onclose = () => {
      dbPromise = null;
    };
  });

  return dbPromise;
}
