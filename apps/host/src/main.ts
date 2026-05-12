// dot.li — Host entry point
//
// Flow: parse URL → render direct preview/local target, or resolve .dot name
// via smoldot → iframe to cid.app.dot.li.

// Polyfill for Safari < 18.4 which lacks requestIdleCallback
if (typeof globalThis.requestIdleCallback !== "function") {
  globalThis.requestIdleCallback = (cb: IdleRequestCallback): number =>
    setTimeout(() => {
      cb({ didTimeout: false, timeRemaining: () => 50 });
    }, 1) as unknown as number;
}

import "@dotli/ui/styles.css";
import * as Sentry from "@sentry/browser";
import {
  initSentry,
  installGlobalErrorHandlers,
  captureException,
} from "@dotli/metrics/sentry";
import {
  showStatus,
  showError,
  showLanding,
  initPhases,
  advancePhase,
  stopStatusTick,
  listenForSandboxStatus,
} from "@dotli/ui/ui";
import { initTopBar, openModePopover } from "@dotli/ui/topbar";
import { listenForSandboxBitswap } from "@dotli/ui/bulletin-bitswap";
import { getCachedCid, setCachedCid } from "@dotli/storage/cid-cache";
import { dur, elapsed } from "@dotli/shared/perf";
import { BASE_DOMAIN, SITE_ID } from "@dotli/config/config";
import { log } from "@dotli/shared/log";
import { serializeError } from "@dotli/shared/errors";
import { escapeHtml } from "@dotli/shared/html";
import { showNotification } from "@dotli/ui/notification";
import {
  getBackend,
  setBackend,
  isVerifiedSession,
  getCacheSettings,
} from "@dotli/config/mode";
import { describeError } from "./errors";
import { parsePreviewTargetUrl } from "./preview-route";

// Surface chunk-load failures explicitly: capture the original cause to
// Sentry and let the user opt into a reload, instead of reloading silently.
window.addEventListener("vite:preloadError", (event) => {
  const evt = event as unknown as { payload?: unknown };
  captureException(evt.payload ?? new Error("vite:preloadError"), {
    kind: "chunk_preload_error",
  });
  showNotification({
    label: "Asset failed to load",
    text: "A new version may have been deployed. Reload to get the latest.",
    dismissMs: 0,
    action: {
      label: "Reload",
      onClick: () => {
        window.location.reload();
      },
    },
  });
});

// Respect the user's dismissal unconditionally — once dismissed, never
// resurface unless the dismissal flag is cleared from localStorage.
if (!/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  const dismissed = localStorage.getItem("desktop-banner-dismissed");
  if (dismissed === null) {
    showNotification({
      label: "Get Polkadot Desktop",
      text: "Full experience with native performance",
      deeplink: "https://polkadot.com/get-started/polkadot-for-desktop",
      icon:
        '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>' +
        '<line x1="8" y1="21" x2="16" y2="21"/>' +
        '<line x1="12" y1="17" x2="12" y2="21"/></svg>',
      iconBackground: "#000",
      dismissMs: 0,
      browserNotification: false,
      onDismiss: () => {
        localStorage.setItem("desktop-banner-dismissed", "1");
      },
    });
  }
}

initSentry("host");
installGlobalErrorHandlers("host");

import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";

// Track WASM module load times via resource timing
if (m.enabled && typeof PerformanceObserver !== "undefined") {
  const wasmObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name.endsWith(".wasm")) {
        const name = entry.name.split("/").pop() ?? "unknown";
        m.distribution(S.WASM_LOAD, entry.duration, "millisecond", {
          module: name,
        });
      }
    }
  });
  wasmObserver.observe({ type: "resource", buffered: true });
}

const T0 = performance.now();

/**
 * Parse a localhost proxy URL from the path.
 *
 * Examples:
 *   "/localhost:5000"          → "http://localhost:5000"
 *   "/localhost:5000/foo/bar"  → "http://localhost:5000/foo/bar"
 *   "/localhost"               → "http://localhost"
 *   "/starter-template.dot"    → null (not a localhost URL)
 */
function parseLocalhostUrl(): string | null {
  const path = window.location.pathname;
  const match = /^\/(localhost(?::\d+)?)(.*)$/.exec(path);
  if (match === null) {
    return null;
  }
  const host = match[1];
  const rest = match[2] || "";
  return `http://${host}${rest}${window.location.search}${window.location.hash}`;
}

/**
 * Extract the .dot label from the current hostname.
 *
 * Examples:
 *   "myapp.dot.li"            → "myapp"
 *   "myapp.localhost"          → "myapp"    (local dev)
 *   "dot.li"                  → null        (landing page)
 *   "localhost"                → null        (landing page)
 *   "cid.app.dot.li"          → null        (handled by app-main.ts)
 *   "cid.app.localhost"       → null        (handled by app-main.ts)
 */
function parseDotLabel(): string | null {
  const hostname = window.location.hostname;

  // Production: name.{BASE_DOMAIN} (but NOT cid.app.{BASE_DOMAIN})
  if (hostname.endsWith(`.${BASE_DOMAIN}`)) {
    if (hostname.endsWith(`.app.${BASE_DOMAIN}`)) {
      return null;
    }
    const label = hostname.slice(0, -(BASE_DOMAIN.length + 1));
    return label || null;
  }

  // Local dev: name.localhost (but NOT cid.app.localhost)
  if (hostname.endsWith(".localhost")) {
    if (hostname.endsWith(".app.localhost")) {
      return null;
    }
    const label = hostname.slice(0, -".localhost".length);
    return label || null;
  }

  // Path-based: /name.dot or /dotli/name.dot (GitHub Pages)
  const path = window.location.pathname;
  const match = /\/([^/]+)\.dot(?:\/|$)/.exec(path);
  if (match !== null) {
    return match[1] || null;
  }

  return null;
}

/**
 * Set the verification shield state in the URL pill.
 *   "verified"   — green: P2P mode, data independently verified by light client
 *   "validating" — yellow: gateway mode, data from trusted source
 */
let topbarHideTimer: ReturnType<typeof setTimeout> | null = null;
let topbarHoverBound = false;
let shieldVerified = false;

function isLoggedIn(): boolean {
  return document.querySelector(".user-badge") !== null;
}

function setTopbarVisible(visible: boolean): void {
  const topbar = document.getElementById("topbar");
  if (!topbar) {
    return;
  }
  const iframe = document.querySelector("iframe");
  topbar.style.transform = visible ? "translateY(0)" : "translateY(-100%)";
  if (iframe) {
    iframe.style.top = visible ? "40px" : "0";
    iframe.style.height = visible ? "calc(100vh - 40px)" : "100vh";
  }
}

function scheduleTopbarHide(): void {
  if (topbarHideTimer !== null) {
    clearTimeout(topbarHideTimer);
  }
  if (!isLoggedIn()) {
    return;
  }
  topbarHideTimer = setTimeout(() => {
    setTopbarVisible(false);
  }, 5000);
}

function setupTopbarAutoHide(): void {
  const topbar = document.getElementById("topbar");
  if (!topbar) {
    return;
  }

  topbar.style.transition = "transform 0.3s ease";
  const iframe = document.querySelector("iframe");
  if (iframe) {
    iframe.style.transition = "top 0.3s ease, height 0.3s ease";
  }

  scheduleTopbarHide();

  if (!topbarHoverBound) {
    topbarHoverBound = true;

    // Invisible trigger zone at the very top — catches hover even over the iframe
    const trigger = document.createElement("div");
    trigger.style.cssText =
      "position:fixed;top:0;left:0;right:0;height:6px;z-index:999;";
    document.body.appendChild(trigger);

    trigger.addEventListener("mouseenter", () => {
      if (topbarHideTimer !== null) {
        clearTimeout(topbarHideTimer);
        topbarHideTimer = null;
      }
      setTopbarVisible(true);
    });
    topbar.addEventListener("mouseenter", () => {
      if (topbarHideTimer !== null) {
        clearTimeout(topbarHideTimer);
        topbarHideTimer = null;
      }
      setTopbarVisible(true);
    });
    topbar.addEventListener("mouseleave", () => {
      scheduleTopbarHide();
    });
  }
}

function setShieldState(state: "validating" | "verified"): void {
  const shield = document.getElementById("verification-shield");
  if (shield !== null) {
    shield.classList.remove("validating", "verified");
    shield.classList.add(state);
    shield.setAttribute(
      "title",
      state === "verified"
        ? "Verified via light client"
        : "Loaded from trusted source",
    );
  }

  const labels: Record<string, string> = {
    verified: "VERIFIED",
    validating: "TRUSTED",
  };
  const colors: Record<string, string> = {
    verified: "#4ade80",
    validating: "#eab308",
  };
  const el = document.getElementById("domain-popover-verification");
  if (el !== null) {
    el.textContent = labels[state];
    el.style.color = colors[state];
  }

  shieldVerified = true;
  setupTopbarAutoHide();
}

/**
 * Fire-and-forget: populate the domain popover with owner info.
 */
function populateOwner(
  resolveOwner: (label: string) => Promise<string | null>,
  label: string,
): void {
  void resolveOwner(label)
    .then((owner) => {
      const el = document.getElementById("domain-popover-owner");
      if (el === null) {
        return;
      }
      if (owner !== null) {
        el.classList.remove("loading");
        el.innerHTML = `${escapeHtml(owner)}<button class="domain-popover-copy" title="Copy address"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`;
        const copyBtn = el.querySelector(".domain-popover-copy");
        copyBtn?.addEventListener("click", (e) => {
          e.stopPropagation();
          void navigator.clipboard.writeText(owner);
          const btn = e.currentTarget as HTMLElement;
          btn.style.color = "#4ade80";
          btn.style.borderColor = "#4ade80";
          setTimeout(() => {
            btn.style.color = "";
            btn.style.borderColor = "";
          }, 1000);
        });
      } else {
        el.textContent = "Unknown";
        el.classList.remove("loading");
      }
    })
    .catch((err: unknown) => {
      // Capture the actual cause so failed owner lookups (timeout, RPC down,
      // decode error) are observable instead of just rendering "Unavailable".
      captureException(err, { surface: "host_owner_lookup" });
      const el = document.getElementById("domain-popover-owner");
      if (el === null) {
        return;
      }
      el.textContent = "Unavailable";
      el.classList.remove("loading");
    });
}

import type * as RenderModule from "@dotli/ui/bridge";
type RenderChunk = typeof RenderModule;

interface DotliE2EApi {
  backend: string;
  subscribeAll: (
    topicsHex: string[],
    timeoutMs: number,
  ) => Promise<{ count: number; isComplete: boolean }>;
  subscribeAny: (
    topicsHex: string[],
    timeoutMs: number,
  ) => Promise<{ count: number; isComplete: boolean }>;
}

function hexToBytes(s: string): Uint8Array {
  const h = s.startsWith("0x") ? s.slice(2) : s;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function runE2EAuthHook(chainBackend: string): Promise<void> {
  log.warn("[dot.li e2e] init auth + statement store");
  const authMod = await import("@dotli/auth/auth");
  authMod.initAuth();
  const store = await authMod.onStatementStoreReady();

  type Filter = { matchAll: Uint8Array[] } | { matchAny: Uint8Array[] };

  function subscribeFor(
    filter: Filter,
    timeoutMs: number,
  ): Promise<{ count: number; isComplete: boolean }> {
    return new Promise((resolve) => {
      let count = 0;
      let lastIsComplete = false;
      const unsub = store.subscribeStatements(filter, (page) => {
        count += page.statements.length;
        lastIsComplete = page.isComplete;
        return undefined;
      });
      setTimeout(() => {
        unsub();
        resolve({ count, isComplete: lastIsComplete });
      }, timeoutMs);
    });
  }

  const api: DotliE2EApi = {
    backend: chainBackend,
    subscribeAll: (topicsHex, timeoutMs) =>
      subscribeFor({ matchAll: topicsHex.map(hexToBytes) }, timeoutMs),
    subscribeAny: (topicsHex, timeoutMs) =>
      subscribeFor({ matchAny: topicsHex.map(hexToBytes) }, timeoutMs),
  };

  (window as unknown as { __dotliE2E: DotliE2EApi }).__dotliE2E = api;
  log.warn(`[dot.li e2e] window.__dotliE2E ready (backend=${chainBackend})`);
  document.title = "dotli-e2e-ready";
}

async function main(): Promise<void> {
  const previewTargetUrl = parsePreviewTargetUrl(window.location);

  // Guard: if running inside an iframe, bail out to avoid a nested
  // dot.li instance with a duplicate topbar.
  if (window.self !== window.top && previewTargetUrl === null) {
    return;
  }

  performance.mark("dotli:main:start");
  log.warn(`[dot.li perf] main() started (${elapsed(T0)})`);

  const chainBackend = getBackend();
  const cacheSettings = getCacheSettings();
  log.warn(`[dot.li perf] chain=${chainBackend}`);
  m.setDefaults({
    chain_backend: chainBackend,
    skip_cid_cache: String(cacheSettings.skipCidCache),
    skip_archive_cache: String(cacheSettings.skipArchiveCache),
  });

  // Pre-warm the protocol iframe for every chain backend so sandboxed apps
  // that call `chainConnect` have a handler waiting on the other side. The
  // submode mapping is 1:1 with the chain backend.
  //   smoldot-shared-worker → "shared-worker"
  //   smoldot-direct        → "direct"
  //   rpc-gateway           → "rpc"
  {
    const subMode: "shared-worker" | "direct" | "rpc" =
      chainBackend === "smoldot-shared-worker"
        ? "shared-worker"
        : chainBackend === "smoldot-direct"
          ? "direct"
          : "rpc";
    // One-shot full-reset signal written by the settings popover before
    // reloading. Forces `skipWorkerCache` for this boot regardless of the
    // persisted cache preference, so the user's explicit "Save & Apply"
    // action guarantees a clean chain DB on the protocol origin.
    let pendingProtocolReset = false;
    try {
      if (sessionStorage.getItem("dotli:pending-reset:protocol") === "1") {
        pendingProtocolReset = true;
        sessionStorage.removeItem("dotli:pending-reset:protocol");
      }
      // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable (Safari private mode); reset flag falls back to false which is the safe default.
    } catch {
      /* sessionStorage unavailable — skip pending-reset pick up */
    }
    const protocolChunkPromise = import("@dotli/protocol/client");
    void protocolChunkPromise.then(
      ({ ensureProtocolFrame, warmupProtocol, setProtocolSubMode }) => {
        setProtocolSubMode(subMode, {
          skipWorkerCache:
            pendingProtocolReset || cacheSettings.skipWorkerCache,
        });
        void ensureProtocolFrame();
        void warmupProtocol();
      },
    );
  }

  // E2E test hook: when `?e2e_init_auth=1` is in the URL, initialize the
  // auth module + statement-store and expose `window.__dotliE2E` for the
  // Playwright spec, then bail out before the normal landing/.dot flow
  // runs. The protocol iframe pre-warm above is what makes
  // `createRemoteChainProvider(...)` work for the smoldot statement-store
  // path; that's why this branch sits *after* the pre-warm.
  if (
    new URLSearchParams(window.location.search).get("e2e_init_auth") === "1"
  ) {
    await runE2EAuthHook(chainBackend);
    return;
  }

  // Initialize top bar UI (auth is lazy-loaded inside topbar when needed)
  const t0 = performance.now();
  initTopBar();
  log.warn(`[dot.li perf] initTopBar() done (${dur(t0)})`);

  const label = parseDotLabel();

  if (label === null && previewTargetUrl !== null) {
    const host = new URL(previewTargetUrl).host;
    log.warn(`[dot.li perf] Preview route: ${host} (${elapsed(T0)})`);

    const urlBar = document.getElementById("topbar-url");
    if (urlBar !== null) {
      urlBar.innerHTML = `<div class="topbar-url-pill localhost-pill" id="url-pill"><svg class="localhost-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg><span class="dot-domain">${escapeHtml(host)}</span></div>`;
    }

    const { renderIframe } = await import("@dotli/ui/bridge");
    await renderIframe(previewTargetUrl, host);
    history.replaceState(
      null,
      "",
      `/__preview?url=${encodeURIComponent(previewTargetUrl)}`,
    );
    document.title = `${host} — ${SITE_ID}`;
    performance.mark("dotli:main:end");
    return;
  }

  const localhostUrl = parseLocalhostUrl();
  if (label === null && localhostUrl !== null) {
    const host = new URL(localhostUrl).host;
    log.warn(`[dot.li perf] Localhost proxy: ${host} (${elapsed(T0)})`);

    const urlBar = document.getElementById("topbar-url");
    if (urlBar !== null) {
      urlBar.innerHTML = `<div class="topbar-url-pill localhost-pill" id="url-pill"><svg class="localhost-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg><span class="dot-domain">${escapeHtml(host)}</span></div>`;
    }

    const { renderIframe } = await import("@dotli/ui/bridge");
    await renderIframe(localhostUrl, host);
    // Deep path was forwarded to the product iframe — strip it so the URL bar doesn't show a stale path
    history.replaceState(null, "", "/" + host);
    document.title = `${host} — ${SITE_ID}`;
    performance.mark("dotli:main:end");
    return;
  }

  if (label === null) {
    log.warn(`[dot.li perf] Landing page — no subdomain (${elapsed(T0)})`);
    showLanding();
    performance.mark("dotli:main:end");
    return;
  }

  // If the user logs in after the shield is already verified, start auto-hide
  window.addEventListener("dotli:authenticated", () => {
    if (shieldVerified) {
      setupTopbarAutoHide();
    }
  });

  // If the user logs out, cancel auto-hide and keep the topbar visible
  window.addEventListener("dotli:logged-out", () => {
    if (topbarHideTimer !== null) {
      clearTimeout(topbarHideTimer);
      topbarHideTimer = null;
    }
    setTopbarVisible(true);
  });

  log.warn(`[dot.li perf] Subdomain detected: "${label}" (${elapsed(T0)})`);

  // Pre-load render chunk in parallel (overlap with CID resolution)
  const renderChunkPromise: Promise<RenderChunk> = import("@dotli/ui/bridge");
  void renderChunkPromise.catch(() => {
    /* fire-and-forget */
  });

  // The topbar DOM nodes are required-by-contract invariants of
  // `index.html`. Their absence is a build/deploy bug, not a recoverable
  // runtime branch — fail loud so monitoring catches it instead of silently
  // leaving the page in its initial loading state.
  const urlBar = document.getElementById("topbar-url");
  if (urlBar === null) {
    const err = new Error("Required DOM node missing: #topbar-url");
    captureException(err, { surface: "host_main_dom_invariant" });
    showError("UI failed to initialise", err.message);
    return;
  }
  urlBar.innerHTML = `<div class="topbar-url-pill" id="url-pill"><svg id="verification-shield" class="verification-shield" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2L3 7v5c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-9-5zm-1 14.59l-3.29-3.3 1.41-1.41L11 13.76l4.88-4.88 1.41 1.41L11 16.59z"/></svg><span><span class="dot-domain">${escapeHtml(label)}</span><span class="dot-tld">.dot</span></span></div>`;

  // Domain info popover toggle
  const urlPill = document.getElementById("url-pill");
  const domainPopover = document.getElementById("domain-popover");
  if (urlPill === null || domainPopover === null) {
    const err = new Error(
      `Required DOM node missing: ${urlPill === null ? "#url-pill" : "#domain-popover"}`,
    );
    captureException(err, { surface: "host_main_dom_invariant" });
    showError("UI failed to initialise", err.message);
    return;
  }
  urlPill.addEventListener("click", (e) => {
    e.stopPropagation();
    domainPopover.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (!domainPopover.contains(e.target as Node)) {
      domainPopover.classList.remove("open");
    }
  });
  window.addEventListener("blur", () => {
    domainPopover.classList.remove("open");
  });

  // Listen for status messages from the sandbox iframe so the loading
  // UI continues seamlessly from resolution into content fetching.
  listenForSandboxStatus();

  // Relay sandbox `bitswap_v1_get` requests to the protocol iframe's smoldot.
  // The sandbox is on a different origin and can't postMessage the protocol
  // iframe directly. The host bridges the two so a single warm Bulletin
  // chain serves every sandbox load instead of cold-starting a second
  // smoldot per page.
  listenForSandboxBitswap();

  const shieldState: "verified" | "validating" = isVerifiedSession(chainBackend)
    ? "verified"
    : "validating";

  if (chainBackend === "smoldot-shared-worker") {
    initPhases(["Starting Worker", "Syncing", "Resolving"]);
  } else if (chainBackend === "smoldot-direct") {
    initPhases(["Starting", "Connecting", "Syncing", "Resolving"]);
  } else {
    initPhases(["Connecting", "Resolving"]);
  }
  advancePhase(0);
  showStatus(`Resolving ${label}.dot`);

  try {
    const cachedCid = cacheSettings.skipCidCache
      ? null
      : await getCachedCid(label);
    if (cachedCid !== null) {
      m.count(S.CACHE_HIT);
      log.warn(
        `[dot.li resolve] path=cache (${chainBackend}) (${elapsed(T0)}) -> ${cachedCid}`,
      );
      // Wrap the warm-path render in a span so its duration is queryable
      // as `dotli.e2e.fast_path` alongside `dotli.e2e.slow_path`.
      await m.span(S.E2E_FAST, async () => {
        setShieldState(shieldState);
        const { renderAppSubdomain } = await renderChunkPromise;
        await renderAppSubdomain(cachedCid, label);
      });
      history.replaceState(null, "", "/");
      performance.mark("dotli:main:end");
      log.warn(`[dot.li perf] === TOTAL (fast path): ${dur(T0)} ===`);
      return;
    }
    m.count(S.CACHE_MISS);
    log.warn(`[dot.li perf] CID cache MISS (${elapsed(T0)})`);

    // One event per cold resolve attempt, BEFORE anything that can fail.
    Sentry.captureMessage("dotli.resolve_attempt", {
      level: "info",
      tags: {
        surface: "host_main_resolve",
        outcome: "pending",
        chain_backend: chainBackend,
      },
    });

    // Wall-clock cold-path duration, emitted as a trace_metric distribution
    // after success. The previous m.span wrapper recorded garbage on the
    // smoldot path (closure detachment across postMessage awaits).
    const coldStartMs = performance.now();
    performance.mark("dotli:resolve:start");
    const resolveStart = performance.now();

    let cid: string | null;
    if (chainBackend !== "rpc-gateway") {
      log.warn(
        `[dot.li resolve] path=smoldot (trustless light-client) (${elapsed(T0)})`,
      );
      const gatewayBtnTimer = setTimeout(() => {
        const hint = document.getElementById("loading-hint");
        if (hint !== null) {
          const btn = document.createElement("button");
          btn.className = "loading-gateway-btn";
          btn.textContent = "Change settings";
          btn.title = "Open settings to change resolution mode";
          btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            openModePopover();
          });
          hint.appendChild(btn);
          hint.classList.add("visible");
        }
      }, 10000);

      try {
        const { resolveDotNameRemote, resolveOwnerRemote } =
          await import("@dotli/protocol/client");
        const { statusToPhase } = await import("@dotli/resolver/resolve");
        populateOwner(resolveOwnerRemote, label);
        cid = await resolveDotNameRemote(label, (msg: string) => {
          const phase = statusToPhase(msg);
          if (phase === "asset-hub-connecting") {
            advancePhase(1);
          } else if (
            phase === "asset-hub-syncing" ||
            phase === "asset-hub-ready"
          ) {
            advancePhase(2);
          } else if (phase === "resolving-content") {
            advancePhase(3);
          }
          showStatus(msg);
        });
      } finally {
        clearTimeout(gatewayBtnTimer);
      }
    } else {
      log.warn(
        `[dot.li resolve] path=json-rpc (gateway mode) (${elapsed(T0)})`,
      );
      const { resolveDotNameViaRpc, resolveOwnerViaRpc } =
        await import("@dotli/resolver/rpc-resolve");
      populateOwner(resolveOwnerViaRpc, label);
      cid = await resolveDotNameViaRpc(label, (msg: string) => {
        showStatus(msg);
      });
    }

    stopStatusTick();
    performance.mark("dotli:resolve:end");
    log.warn(
      `[dot.li resolve] RESOLVED ${label}.dot via ${chainBackend} in ${dur(resolveStart)} (total ${elapsed(T0)}) -> ${cid ?? "null"}`,
    );

    if (cid === null) {
      showError(
        `${label}.dot`,
        "This domain has no content set. The owner needs to publish content to the Bulletin Chain and set the content hash.",
      );
      performance.mark("dotli:main:end");
      return;
    }

    if (!cacheSettings.skipCidCache) {
      requestIdleCallback(() => {
        void setCachedCid(label, cid);
      });
    }

    setShieldState(shieldState);

    const { renderAppSubdomain } = await renderChunkPromise;
    await renderAppSubdomain(cid, label);

    m.distribution(S.E2E_SLOW, performance.now() - coldStartMs, "millisecond", {
      outcome: "ok",
      chain_backend: chainBackend,
    });

    history.replaceState(null, "", "/");
    performance.mark("dotli:main:end");
    log.warn(`[dot.li perf] === TOTAL: ${dur(T0)} ===`);
  } catch (err) {
    performance.mark("dotli:main:end");
    // Report before rendering so monitoring always sees the root cause, even
    // if `showError()` itself throws (e.g. a DOM node is missing). The global
    // unhandled-rejection handler doesn't catch this — the try/catch here
    // already has. Carry the active dependency as a tag so Sentry + the
    // user-visible error both attribute the failure to the specific
    // dependency the chosen mode dialed.
    const dependency =
      chainBackend === "rpc-gateway" ? "asset-hub-rpc" : "smoldot";
    captureException(err, {
      surface: "host_main_resolve",
      outcome: "error",
      dependency,
      chain_backend: chainBackend,
    });
    // Full cause chain to console for devs.
    log.error(
      `[dot.li] Resolution failed via ${dependency}: ${serializeError(err)}`,
    );
    const error = describeError(err, chainBackend !== "rpc-gateway");
    if (error.recovery === "none") {
      showError("Domain can't be reached", error.message);
      return;
    }
    if (error.recovery === "reload") {
      showError("Domain can't be reached", error.message, {
        label: "Reload",
        onClick: () => {
          window.location.reload();
        },
      });
      return;
    }
    // Tiered failover: any smoldot becomes rpc-gateway, rpc-gateway becomes smoldot-shared-worker.
    const nextBackend =
      chainBackend === "rpc-gateway" ? "smoldot-shared-worker" : "rpc-gateway";
    const btnLabel =
      nextBackend === "rpc-gateway"
        ? "Try with RPC Node (trusted provider)"
        : "Try Light Client (smoldot worker)";
    showError("Domain can't be reached", error.message, {
      label: btnLabel,
      onClick: () => {
        setBackend(nextBackend);
        window.location.reload();
      },
    });
  }
}

void main();
