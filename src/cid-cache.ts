// dot.li — IndexedDB-backed label→CID cache
//
// Enables stale-while-revalidate: on repeat visits, render from
// the cached CID instantly while smoldot validates in the background.

const DB_NAME = "dotli-cid-cache";
const STORE = "cids";
const DB_VERSION = 1;

interface CidEntry {
  label: string;
  cid: string;
  timestamp: number;
}

let cachedDb: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (cachedDb !== null) {
    return Promise.resolve(cachedDb);
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "label" });
    };
    req.onsuccess = () => {
      cachedDb = req.result;
      cachedDb.onclose = () => {
        cachedDb = null;
      };
      resolve(cachedDb);
    };
    req.onerror = () => {
      reject(new Error("Failed to open CID cache DB"));
    };
  });
}

export async function getCachedCid(label: string): Promise<string | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(label);
      req.onsuccess = () => {
        const entry = req.result as CidEntry | undefined;
        resolve(entry?.cid ?? null);
      };
      req.onerror = () => {
        resolve(null);
      };
    });
  } catch {
    return null;
  }
}

export async function setCachedCid(label: string, cid: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const entry: CidEntry = {
      label,
      cid,
      timestamp: Date.now(),
    };
    tx.objectStore(STORE).put(entry);
  } catch {
    // Cache write failure is non-critical
  }
}
