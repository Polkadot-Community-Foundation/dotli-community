// dot.li — Host Service Worker
//
// Smoldot chain sync only — no archive serving, no fetch interception.
// Runs on name.dot.li to persist smoldot relay chain state across navigations.

/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { handleConnect, handleStatus, ensureSmoldot } from "./sw-smoldot";
import { TIMEOUTS } from "./config";

// ── SW Lifecycle ─────────────────────────────────────────────

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
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
