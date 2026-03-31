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

// ── Relay chain DB extraction + save ──────────────────────────

/** Minimal chain interface for JSON-RPC relay DB extraction. */
export interface ChainRpc {
  sendJsonRpc(rpc: string): void;
  nextJsonRpcResponse(): Promise<string>;
}

let dbSaveId = 0;

/**
 * Extract the relay chain database via JSON-RPC and save to IndexedDB.
 *
 * Shared by both main-thread smoldot (`smoldot.ts`) and SW smoldot
 * (`sw-smoldot.ts`). The `logFn` parameter allows each caller to use
 * its own logging mechanism (`log.warn` vs `console.warn` in SW context).
 */
export async function extractAndSaveChainDb(
  chain: ChainRpc,
  maxSize: number,
  logFn: (...args: unknown[]) => void,
  prefix: string,
  chainName = "paseo",
): Promise<void> {
  const id = ++dbSaveId;
  try {
    chain.sendJsonRpc(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "chainHead_unstable_finalizedDatabase",
        params: [maxSize],
      }),
    );
    const raw = await chain.nextJsonRpcResponse();
    const resp = JSON.parse(raw) as { id?: number; result?: string };
    if (resp.id === id && typeof resp.result === "string") {
      await saveChainDb(chainName, resp.result);
      logFn(
        `${prefix} Saved ${chainName} DB (${String(Math.round(resp.result.length / 1024))} KB)`,
      );
    }
  } catch {
    // Non-critical — DB persistence failure doesn't affect functionality
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
