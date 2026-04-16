// dot.li — Host entry point
//
// Flow: parse URL → resolve .dot name via smoldot → iframe to cid.app.dot.li

// Reload once on chunk load failure (stale HTML referencing deleted assets).
window.addEventListener("vite:preloadError", () => {
  if (sessionStorage.getItem("dotli:chunk-reload") === null) {
    sessionStorage.setItem("dotli:chunk-reload", "1");
    window.location.reload();
  }
});

// Polyfill for Safari < 18.4 which lacks requestIdleCallback
if (typeof globalThis.requestIdleCallback !== "function") {
  globalThis.requestIdleCallback = (cb: IdleRequestCallback): number =>
    setTimeout(() => {
      cb({ didTimeout: false, timeRemaining: () => 50 } as IdleDeadline);
    }, 1) as unknown as number;
}

import "@dotli/ui/styles.css";
import { initSentry } from "@dotli/metrics/sentry";
import {
  showStatus,
  showError,
  showLanding,
  initPhases,
  advancePhase,
  stopStatusTick,
  listenForSandboxStatus,
} from "@dotli/ui/ui";
import { initTopBar } from "@dotli/ui/topbar";
import { getCachedCid, setCachedCid } from "@dotli/storage/cid-cache";
import { dur, elapsed } from "@dotli/shared/perf";
import { BASE_DOMAIN, SITE_ID } from "@dotli/config/config";
import { log } from "@dotli/shared/log";
import { escapeHtml } from "@dotli/shared/html";
import { showNotification } from "@dotli/ui/notification";
import {
  getMode,
  setMode,
  isP2pMode,
  getCacheSettings,
} from "@dotli/config/mode";

// ── Desktop download banner ──────────────────────────────
if (!/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  const dismissed = localStorage.getItem("desktop-banner-dismissed");
  if (dismissed === null || Math.random() <= 0.05) {
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
 *   "myapp.dot.li"              → "myapp"
 *   "myapp.dot.li.localhost"    → "myapp"    (local_gateway)
 *   "myapp.localhost"            → "myapp"    (bare preview server)
 *   "dot.li"                    → null        (landing page)
 *   "dot.li.localhost"          → null        (landing page via gateway)
 *   "localhost"                  → null        (landing page)
 *   "cid.app.dot.li"            → null        (handled by app-main.ts)
 *   "cid.app.dot.li.localhost"  → null        (handled by app-main.ts)
 *   "cid.app.localhost"         → null        (handled by app-main.ts)
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

  // Local gateway: name.{BASE_DOMAIN}.localhost — production-shaped URLs
  // served by local_gateway/ (Caddy fronting the preview server).
  const gatewaySuffix = `.${BASE_DOMAIN}.localhost`;
  if (hostname.endsWith(gatewaySuffix)) {
    if (hostname.endsWith(`.app${gatewaySuffix}`)) {
      return null;
    }
    const label = hostname.slice(0, -gatewaySuffix.length);
    return label || null;
  }

  // Local dev: name.localhost (but NOT cid.app.localhost, and NOT the
  // bare gateway base `dot.li.localhost`, which should fall through to
  // the path matcher so /<name>.dot URLs still work).
  if (
    hostname.endsWith(".localhost") &&
    hostname !== `${BASE_DOMAIN}.localhost`
  ) {
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
    .catch(() => {
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

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Guard: if running inside an iframe, bail out to avoid a nested
  // dot.li instance with a duplicate topbar.
  if (window.self !== window.top) {
    return;
  }

  performance.mark("dotli:main:start");
  log.warn(`[dot.li perf] main() started (${elapsed(T0)})`);

  const mode = getMode();
  const cacheSettings = getCacheSettings();
  log.warn(`[dot.li perf] mode=${mode}`);
  m.tag("dotli_mode", mode);
  m.tag("skip_cid_cache", String(cacheSettings.skipCidCache));
  m.tag("skip_archive_cache", String(cacheSettings.skipArchiveCache));

  // Pre-warm the protocol iframe for every mode so sandboxed apps that call
  // `chainConnect` have a handler waiting on the other side. Each mode maps
  // to a protocol-side submode:
  //   p2p-shared-worker → "shared-worker" (smoldot in SharedWorker)
  //   p2p-direct        → "direct"        (smoldot in this iframe)
  //   gateway           → "rpc"           (trusted WSS JSON-RPC, no smoldot)
  {
    const subMode: "shared-worker" | "direct" | "rpc" =
      mode === "p2p-shared-worker"
        ? "shared-worker"
        : mode === "p2p-direct"
          ? "direct"
          : "rpc";
    const protocolChunkPromise = import("@dotli/protocol/client");
    void protocolChunkPromise.then(
      ({ ensureProtocolFrame, warmupProtocol, setProtocolSubMode }) => {
        setProtocolSubMode(subMode);
        void ensureProtocolFrame();
        void warmupProtocol();
      },
    );
  }

  // Initialize top bar UI (auth is lazy-loaded inside topbar when needed)
  const t0 = performance.now();
  initTopBar();
  log.warn(`[dot.li perf] initTopBar() done (${dur(t0)})`);

  const label = parseDotLabel();

  // ── Localhost proxy: render local dev server directly in iframe ──
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

  // Show the .dot domain in the URL bar
  const urlBar = document.getElementById("topbar-url");
  if (urlBar === null) {
    return;
  }
  urlBar.innerHTML = `<div class="topbar-url-pill" id="url-pill"><svg id="verification-shield" class="verification-shield" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2L3 7v5c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-9-5zm-1 14.59l-3.29-3.3 1.41-1.41L11 13.76l4.88-4.88 1.41 1.41L11 16.59z"/></svg><span><span class="dot-domain">${escapeHtml(label)}</span><span class="dot-tld">.dot</span></span></div>`;

  // Domain info popover toggle
  const urlPill = document.getElementById("url-pill");
  const domainPopover = document.getElementById("domain-popover");
  if (urlPill === null || domainPopover === null) {
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

  const shieldState = isP2pMode(mode) ? "verified" : "validating";

  if (mode === "p2p-shared-worker") {
    initPhases(["Starting Worker", "Syncing", "Resolving"]);
  } else if (mode === "p2p-direct") {
    initPhases(["Starting", "Connecting", "Syncing", "Resolving"]);
  } else {
    initPhases(["Connecting", "Resolving"]);
  }
  advancePhase(0);
  showStatus(`Resolving ${label}.dot`);

  try {
    // ── Fast path: CID cache hit → render immediately ──
    const cachedCid = cacheSettings.skipCidCache
      ? null
      : await getCachedCid(label);
    if (cachedCid !== null) {
      m.count(S.CACHE_HIT);
      log.warn(
        `[dot.li resolve] path=cache (${mode}) (${elapsed(T0)}) -> ${cachedCid}`,
      );
      setShieldState(shieldState);
      const { renderAppSubdomain } = await renderChunkPromise;
      await renderAppSubdomain(cachedCid, label);
      history.replaceState(null, "", "/");

      const totalMs = performance.now() - T0;
      m.measure(S.E2E_FAST, totalMs);
      m.distribution(S.E2E_FAST, totalMs);
      performance.mark("dotli:main:end");
      log.warn(`[dot.li perf] === TOTAL (fast path): ${dur(T0)} ===`);
      return;
    }
    m.count(S.CACHE_MISS);
    log.warn(`[dot.li perf] CID cache MISS (${elapsed(T0)})`);

    // ── Full resolution path (single mode, no racing) ──
    performance.mark("dotli:resolve:start");
    const resolveStart = performance.now();
    const stopResolve = m.timer(S.RESOLVE_TOTAL);
    let cid: string | null;

    if (isP2pMode(mode)) {
      log.warn(
        `[dot.li resolve] path=smoldot (trustless light-client) (${elapsed(T0)})`,
      );

      // Show a "Switch to Gateway" button after 5s so the user can bail
      // out of a slow P2P sync without opening the settings popover.
      const gatewayBtnTimer = setTimeout(() => {
        const hint = document.getElementById("loading-hint");
        if (hint !== null) {
          hint.innerHTML = "";
          const btn = document.createElement("button");
          btn.className = "loading-gateway-btn";
          btn.textContent = "Switch to Gateway";
          btn.title = "Use a trusted RPC node instead (faster)";
          btn.addEventListener("click", () => {
            setMode("gateway");
            window.location.reload();
          });
          hint.appendChild(btn);
          hint.classList.add("visible");
        }
      }, 5000);

      const { resolveDotNameRemote, resolveOwnerRemote } =
        await import("@dotli/protocol/client");
      populateOwner(resolveOwnerRemote, label);
      cid = await resolveDotNameRemote(label, (msg: string) => {
        if (msg.includes("Discovering") || msg.includes("peers")) {
          advancePhase(1);
        }
        if (msg.startsWith("Syncing #") || msg.startsWith("Synced to")) {
          advancePhase(2);
        }
        if (msg.includes("Resolving content")) {
          advancePhase(3);
        }
        showStatus(msg);
      });
      clearTimeout(gatewayBtnTimer);
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
    stopResolve();
    performance.mark("dotli:resolve:end");
    log.warn(
      `[dot.li resolve] RESOLVED ${label}.dot via ${mode} in ${dur(resolveStart)} (total ${elapsed(T0)}) -> ${cid ?? "null"}`,
    );
    m.tag("resolve_source", mode);

    if (cid === null) {
      showError(
        `${label}.dot`,
        "This domain has no content set. The owner needs to publish content to the Bulletin Chain and set the content hash.",
      );
      return;
    }

    // Always write to cache even when skipCidCache is true — populates
    // for when the user re-enables the CID cache toggle.
    requestIdleCallback(() => {
      void setCachedCid(label, cid);
    });

    setShieldState(shieldState);

    // Render: iframe to cid.app.dot.li
    const { renderAppSubdomain } = await renderChunkPromise;
    await renderAppSubdomain(cid, label);

    const totalMs = performance.now() - T0;
    m.measure(S.E2E_SLOW, totalMs);
    m.distribution(S.E2E_SLOW, totalMs);
    history.replaceState(null, "", "/");
    performance.mark("dotli:main:end");
    log.warn(`[dot.li perf] === TOTAL: ${dur(T0)} ===`);
  } catch (err) {
    performance.mark("dotli:main:end");
    const message = err instanceof Error ? err.message : String(err);
    showError("Resolution failed", message);
  }
}

void main();
