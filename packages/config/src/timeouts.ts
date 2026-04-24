// Timeouts (ms)
export const TIMEOUTS = {
  /** SW cache lookup before falling through */
  SW_CACHE_LOOKUP: 3_000,
  /** Waiting for SW controllerchange after registration */
  SW_READY: 10_000,
  /** P2P fetch abort (per attempt) */
  P2P_FETCH: 30_000,
  /** SharedWorker readiness timeout — must exceed `ASSET_HUB_FINALIZED_SYNC`
   * so the outer wait doesn't race the inner sync timeout. */
  SHARED_WORKER_READY: 210_000,
  /** Upper bound on `getFinalizedBlock()` while bootstrapping smoldot. */
  ASSET_HUB_FINALIZED_SYNC: 180_000,
} as const;
