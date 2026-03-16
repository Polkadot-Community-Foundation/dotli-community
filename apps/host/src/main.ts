// dot.li — Host entry point
//
// Flow: parse URL → resolve .dot name via smoldot → iframe to cid.app.dot.li

// Polyfill for Safari < 18.4 which lacks requestIdleCallback
if (typeof globalThis.requestIdleCallback !== "function") {
  globalThis.requestIdleCallback = (cb: IdleRequestCallback): number =>
    setTimeout(() => {
      cb({ didTimeout: false, timeRemaining: () => 50 } as IdleDeadline);
    }, 1) as unknown as number;
}

import "@dotli/core/styles.css";
import * as Sentry from "@sentry/browser";
import { showStatus, showError, showLanding } from "@dotli/core/ui";
import { initTopBar } from "@dotli/core/topbar";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN as string,
});
import { getCachedCid, setCachedCid } from "@dotli/core/cid-cache";
import { dur } from "@dotli/core/perf";
import { TIMEOUTS, BASE_DOMAIN, SITE_ID } from "@dotli/core/config";
import { log } from "@dotli/core/log";

const T0 = performance.now();
function elapsed(): string {
  return `+${((performance.now() - T0) / 1000).toFixed(3)}s`;
}

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
 * Register the host Service Worker for smoldot persistence.
 */
async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    const swUrl = import.meta.env.DEV
      ? "/src/host-sw.ts"
      : `${import.meta.env.BASE_URL}host-sw.js`;
    const swScope = import.meta.env.DEV ? "/" : import.meta.env.BASE_URL;
    await navigator.serviceWorker.register(swUrl, {
      type: "module",
      scope: swScope,
    });

    // Wait until the SW is controlling this page
    if (navigator.serviceWorker.controller) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Service Worker not available after 10s"));
      }, TIMEOUTS.SW_READY);
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        clearTimeout(timeout);
        resolve();
      });
      void navigator.serviceWorker.ready.then((registration) => {
        if (navigator.serviceWorker.controller) {
          clearTimeout(timeout);
          resolve();
        } else if (registration.active) {
          registration.active.postMessage({ type: "SW_CLAIM_EVENT" });
        }
      });
    });
  } catch (err) {
    log.warn("[dot.li] Service worker registration failed:", err);
  }
}

/**
 * Set the verification shield state in the URL pill.
 *   "validating" — yellow: loaded from cache, checking on-chain
 *   "verified"   — green: on-chain CID matches cached version
 *   "stale"      — red: on-chain CID differs (content outdated)
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

function setShieldState(
  state: "validating" | "verified" | "stale" | "gateway",
): void {
  const shield = document.getElementById("verification-shield");
  if (shield !== null) {
    shield.classList.remove("validating", "verified", "stale", "gateway");
    shield.classList.add(state);
  }

  const labels: Record<string, string> = {
    validating: "VALIDATING",
    verified: "VERIFIED",
    stale: "OUTDATED",
    gateway: "GATEWAY",
  };
  const colors: Record<string, string> = {
    verified: "#4ade80",
    stale: "#f87171",
    validating: "#eab308",
    gateway: "#f97316",
  };
  const el = document.getElementById("domain-popover-verification");
  if (el !== null) {
    el.textContent = labels[state];
    el.style.color = colors[state];
  }

  if (state === "verified") {
    shieldVerified = true;
    setupTopbarAutoHide();
  }
}

/**
 * Show a toast when the on-chain CID has changed since the cached version.
 */
function showUpdateBanner(): void {
  if (document.getElementById("dotli-update-banner")) {
    return;
  }
  const banner = document.createElement("div");
  banner.id = "dotli-update-banner";
  banner.className = "toast-card update-banner";
  banner.innerHTML = `
    <div class="toast-card-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="23 4 23 10 17 10" />
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
      </svg>
    </div>
    <div class="toast-card-text">
      <span class="toast-card-title">A new version is available</span>
      <span class="toast-card-subtitle">Refresh to load the latest version</span>
    </div>
    <button class="update-banner-action">Refresh</button>
    <button class="toast-card-close" aria-label="Dismiss">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>`;
  banner
    .querySelector(".update-banner-action")
    ?.addEventListener("click", () => {
      window.location.reload();
    });
  banner.querySelector(".toast-card-close")?.addEventListener("click", () => {
    banner.classList.add("hidden");
  });
  document.body.appendChild(banner);
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
        el.innerHTML = `${owner}<button class="domain-popover-copy" title="Copy address"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`;
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

// ── Extracted helpers for main() ─────────────────────────────

interface ResolveWinner {
  cid: string;
  source: "gateway" | "chain";
}

/**
 * Race gateway and smoldot resolution — first non-null CID wins.
 */
function raceResolvers(
  gatewayPromise: Promise<string | null>,
  smoldotPromise: Promise<string | null>,
): Promise<ResolveWinner | null> {
  return new Promise<ResolveWinner | null>((resolve) => {
    let done = false;
    const tryResolve = (
      cid: string | null,
      source: "gateway" | "chain",
    ): void => {
      if (!done && cid !== null) {
        done = true;
        resolve({ cid, source });
      }
    };

    gatewayPromise
      .then((cid) => {
        tryResolve(cid, "gateway");
      })
      .catch(() => {
        /* fire-and-forget */
      });
    smoldotPromise
      .then((cid) => {
        tryResolve(cid, "chain");
      })
      .catch(() => {
        /* fire-and-forget */
      });

    void Promise.allSettled([gatewayPromise, smoldotPromise]).then(() => {
      if (!done) {
        resolve(null);
      }
    });
  });
}

/**
 * When gateway resolved first, verify the CID against smoldot in the background.
 */
function handleGatewayWinner(
  label: string,
  gatewayCid: string,
  smoldotPromise: Promise<string | null>,
): void {
  void smoldotPromise
    .then((chainCid) => {
      if (chainCid !== null && chainCid !== gatewayCid) {
        log.warn(
          `[dot.li] CID mismatch: gateway=${gatewayCid}, chain=${chainCid}`,
        );
        requestIdleCallback(() => {
          void setCachedCid(label, chainCid);
        });
        setShieldState("stale");
        showUpdateBanner();
      } else if (chainCid !== null) {
        log.warn("[dot.li] Gateway CID verified by chain");
        setShieldState("verified");
      }
    })
    .catch(() => {
      /* fire-and-forget */
    });
}

import type * as RenderModule from "@dotli/core/render";
type RenderChunk = typeof RenderModule;

// ── Main ─────────────────────────────────────────────────────

let destroyClientFn: (() => void) | null = null;

async function main(): Promise<void> {
  // Guard: if running inside an iframe, bail out to avoid a nested
  // dot.li instance with a duplicate topbar.
  if (window.self !== window.top) {
    return;
  }

  performance.mark("dotli:main:start");
  log.warn(`[dot.li perf] main() started (${elapsed()})`);

  // Pre-warm smoldot unconditionally — start downloading the resolve chunk
  // and kick off relay chain sync immediately.
  const resolveChunkStart = performance.now();
  const resolveChunkPromise = import("@dotli/core/resolve");
  void resolveChunkPromise.then(({ getSmoldot, getRelayChain }) => {
    getSmoldot();
    void getRelayChain();
  });

  // Initialize top bar UI (auth is lazy-loaded inside topbar when needed)
  const t0 = performance.now();
  initTopBar();
  log.warn(`[dot.li perf] initTopBar() done (${dur(t0)})`);

  const label = parseDotLabel();

  // ── Localhost proxy: render local dev server directly in iframe ──
  const localhostUrl = parseLocalhostUrl();
  if (label === null && localhostUrl !== null) {
    const host = new URL(localhostUrl).host;
    log.warn(`[dot.li perf] Localhost proxy: ${host} (${elapsed()})`);

    const urlBar = document.getElementById("topbar-url");
    if (urlBar !== null) {
      urlBar.innerHTML = `<div class="topbar-url-pill localhost-pill" id="url-pill"><svg class="localhost-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg><span class="dot-domain">${host}</span></div>`;
    }

    const { renderIframe } = await import("@dotli/core/render");
    await renderIframe(localhostUrl, host);
    document.title = `${host} — ${SITE_ID}`;
    performance.mark("dotli:main:end");
    return;
  }

  if (label === null) {
    log.warn(`[dot.li perf] Landing page — no subdomain (${elapsed()})`);
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

  log.warn(`[dot.li perf] Subdomain detected: "${label}" (${elapsed()})`);

  // ── TEMPORARY: external URL overrides (remove when domains are on-chain) ──
  const TEMP_OVERRIDES: Partial<Record<string, string>> = {
    polka: "https://polkadotcom-spektr-sdk-demo.teleport.parity.io/",
  };
  const overrideUrl = TEMP_OVERRIDES[label];
  if (overrideUrl !== undefined) {
    const topbar = document.getElementById("topbar");
    if (topbar !== null) {
      topbar.style.display = "none";
    }
    const app = document.getElementById("app") ?? document.body;
    app.innerHTML = "";
    const iframe = document.createElement("iframe");
    iframe.src = overrideUrl;
    iframe.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:100vh;border:none;margin:0;padding:0;";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    app.appendChild(iframe);
    document.title = `${label}.dot`;
    performance.mark("dotli:main:end");
    return;
  }
  // ── END TEMPORARY ──

  // Pre-load chunks in parallel (overlap with CID resolution)
  const gatewayChunkPromise = import("@dotli/core/gateway-resolve");
  void gatewayChunkPromise.catch(() => {
    /* fire-and-forget */
  });
  const renderChunkPromise: Promise<RenderChunk> = import("@dotli/core/render");
  void renderChunkPromise.catch(() => {
    /* fire-and-forget */
  });
  const swProviderChunkPromise = import("@dotli/core/sw-provider");
  void swProviderChunkPromise.catch(() => {
    /* fire-and-forget */
  });

  // Show the .dot domain in the URL bar
  const urlBar = document.getElementById("topbar-url");
  if (urlBar === null) {
    return;
  }
  urlBar.innerHTML = `<div class="topbar-url-pill" id="url-pill"><svg id="verification-shield" class="verification-shield" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2L3 7v5c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-9-5zm-1 14.59l-3.29-3.3 1.41-1.41L11 13.76l4.88-4.88 1.41 1.41L11 16.59z"/></svg><span><span class="dot-domain">${label}</span><span class="dot-tld">.dot</span></span></div>`;

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

  showStatus(`Resolving ${label}.dot...`);

  try {
    // Start SW registration in parallel (for smoldot persistence)
    performance.mark("dotli:sw:start");
    const swStart = performance.now();
    log.warn(`[dot.li perf] SW registration started (${elapsed()})`);

    if (!navigator.serviceWorker.controller) {
      void resolveChunkPromise.then(({ markFreshSwRegistration }) => {
        markFreshSwRegistration();
      });
    }

    const swReady = registerServiceWorker().then(() => {
      performance.mark("dotli:sw:end");
      log.warn(
        `[dot.li perf] SW registration done (${dur(swStart)}, ${elapsed()})`,
      );
    });
    void swReady.catch(() => {
      /* fire-and-forget */
    });

    // ── Fast path: CID cache hit → iframe to cid.app.dot.li ──
    const cachedCid = await getCachedCid(label);
    if (cachedCid !== null) {
      log.warn(`[dot.li perf] CID cache HIT: ${cachedCid} (${elapsed()})`);
      setShieldState("validating");
      const { renderAppSubdomain } = await renderChunkPromise;
      await renderAppSubdomain(cachedCid, label);
      performance.mark("dotli:main:end");
      log.warn(`[dot.li perf] === TOTAL (fast path): ${dur(T0)} ===`);

      // Background: validate CID is still current
      resolveChunkPromise
        .then(({ resolveDotName, resolveOwner, destroyClient }) => {
          destroyClientFn = destroyClient;
          populateOwner(resolveOwner, label);
          resolveDotName(label).then((freshCid) => {
            if (freshCid !== null && freshCid !== cachedCid) {
              log.warn(`[dot.li] CID changed: ${cachedCid} → ${freshCid}`);
              requestIdleCallback(() => {
                void setCachedCid(label, freshCid);
              });
              setShieldState("stale");
              showUpdateBanner();
            } else if (freshCid !== null) {
              requestIdleCallback(() => {
                void setCachedCid(label, freshCid);
              });
              setShieldState("verified");
            }
          }, log.error);
        })
        .catch(log.error);
      return;
    }
    log.warn(`[dot.li perf] CID cache MISS (${elapsed()})`);

    // ── Full resolution path ──

    // Check if SW smoldot is already synced
    const { isSwSmoldotReady } = await swProviderChunkPromise;
    const swSmoldotReady = await isSwSmoldotReady();

    performance.mark("dotli:resolve:start");
    let gatewayPromise: Promise<string | null>;
    if (swSmoldotReady) {
      log.warn(
        `[dot.li perf] SW smoldot ready — skipping gateway (${elapsed()})`,
      );
      gatewayPromise = Promise.resolve(null);
    } else {
      log.warn(
        `[dot.li perf] Starting gateway + smoldot resolve... (${elapsed()})`,
      );
      gatewayPromise = gatewayChunkPromise
        .then(({ resolveViaGateway }) => resolveViaGateway(label))
        .catch(() => null as string | null);
    }

    log.warn(`[dot.li perf] Awaiting resolve chunk... (${elapsed()})`);
    const { resolveDotName, resolveOwner, destroyClient } =
      await resolveChunkPromise;
    log.warn(
      `[dot.li perf] Resolve chunk loaded (${dur(resolveChunkStart)}, ${elapsed()})`,
    );
    destroyClientFn = destroyClient;
    populateOwner(resolveOwner, label);

    let showSmoldotStatus = true;
    const smoldotPromise = resolveDotName(label, (msg: string) => {
      if (showSmoldotStatus) {
        showStatus(msg);
      }
    });

    const resolveStart = performance.now();
    const winner = await raceResolvers(gatewayPromise, smoldotPromise);
    performance.mark("dotli:resolve:end");
    log.warn(
      `[dot.li perf] Resolution done (${dur(resolveStart)}, ${elapsed()}) → ${winner?.source ?? "none"}: ${winner?.cid ?? "null"}`,
    );

    if (winner === null) {
      showError(
        `${label}.dot`,
        "This domain has no content set. The owner needs to publish content to the Bulletin Chain and set the content hash.",
      );
      return;
    }

    const cid = winner.cid;

    requestIdleCallback(() => {
      void setCachedCid(label, cid);
    });

    if (winner.source === "gateway") {
      setShieldState("gateway");
      showSmoldotStatus = false;
      handleGatewayWinner(label, cid, smoldotPromise);
    } else {
      setShieldState("verified");
    }

    // Render: iframe to cid.app.dot.li
    const { renderAppSubdomain } = await renderChunkPromise;
    await renderAppSubdomain(cid, label);
    performance.mark("dotli:main:end");
    log.warn(`[dot.li perf] === TOTAL: ${dur(T0)} ===`);
  } catch (err) {
    performance.mark("dotli:main:end");
    const message = err instanceof Error ? err.message : String(err);
    showError("Resolution failed", message);
  }
}

// Cleanup on page unload
window.addEventListener("beforeunload", () => {
  destroyClientFn?.();
});

void main();
