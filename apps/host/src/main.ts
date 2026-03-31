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
import * as Sentry from "@sentry/browser";
import { showStatus, showError, showLanding } from "@dotli/ui/ui";
import { initTopBar } from "@dotli/ui/topbar";
import { getCachedCid, setCachedCid } from "@dotli/storage/cid-cache";
import { dur, elapsed } from "@dotli/shared/perf";
import { BASE_DOMAIN, SITE_ID } from "@dotli/config/config";
import { log } from "@dotli/shared/log";
import { showNotification } from "@dotli/ui/notification";

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

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN_HOST as string | undefined,
  environment:
    (import.meta.env.VITE_APP_ENV as string | undefined) ?? "development",
  release: import.meta.env.VITE_COMMIT_SHA as string | undefined,
  sendDefaultPii: false,
});

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

function setShieldState(state: "validating" | "verified" | "stale"): void {
  const shield = document.getElementById("verification-shield");
  if (shield !== null) {
    shield.classList.remove("validating", "verified", "stale");
    shield.classList.add(state);
  }

  const labels: Record<string, string> = {
    validating: "VALIDATING",
    verified: "VERIFIED",
    stale: "OUTDATED",
  };
  const colors: Record<string, string> = {
    verified: "#4ade80",
    stale: "#f87171",
    validating: "#eab308",
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
 * Verify a cached CID against the on-chain value in the background.
 * If the chain returns a different CID, update the cache and show a banner.
 */
function verifyCachedCid(
  label: string,
  cachedCid: string,
  protocolChunkPromise: Promise<ProtocolChunk>,
): void {
  void protocolChunkPromise
    .then(async ({ resolveDotNameRemote }) => {
      const chainCid = await resolveDotNameRemote(label);
      if (chainCid !== null && chainCid !== cachedCid) {
        log.warn(
          `[dot.li] CID mismatch: cached=${cachedCid}, chain=${chainCid}`,
        );
        requestIdleCallback(() => {
          void setCachedCid(label, chainCid);
        });
        setShieldState("stale");
        showNotification({
          label: "A new version is available",
          text: "Refresh to load the latest version",
          icon:
            '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<polyline points="23 4 23 10 17 10"/>' +
            '<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
          iconBackground: "#000",
          dismissMs: 0,
          browserNotification: false,
          action: {
            label: "Refresh",
            onClick: () => {
              window.location.reload();
            },
          },
        });
      } else if (chainCid !== null) {
        log.warn("[dot.li] Cached CID verified by chain");
        setShieldState("verified");
      }
    })
    .catch(() => {
      /* fire-and-forget — cached version still works */
    });
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

import type * as RenderModule from "@dotli/ui/bridge";
type RenderChunk = typeof RenderModule;
import type * as ProtocolModule from "@dotli/protocol/client";
type ProtocolChunk = typeof ProtocolModule;

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Guard: if running inside an iframe, bail out to avoid a nested
  // dot.li instance with a duplicate topbar.
  if (window.self !== window.top) {
    return;
  }

  performance.mark("dotli:main:start");
  log.warn(`[dot.li perf] main() started (${elapsed(T0)})`);

  // Pre-warm the shared protocol iframe immediately so the smoldot runtime
  // and shared storage origin are alive before resolution starts.
  const protocolChunkStart = performance.now();
  const protocolChunkPromise = import("@dotli/protocol/client");
  void protocolChunkPromise.then(({ ensureProtocolFrame, warmupProtocol }) => {
    void ensureProtocolFrame();
    void warmupProtocol();
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
    log.warn(`[dot.li perf] Localhost proxy: ${host} (${elapsed(T0)})`);

    const urlBar = document.getElementById("topbar-url");
    if (urlBar !== null) {
      urlBar.innerHTML = `<div class="topbar-url-pill localhost-pill" id="url-pill"><svg class="localhost-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg><span class="dot-domain">${host}</span></div>`;
    }

    const { renderIframe } = await import("@dotli/ui/bridge");
    await renderIframe(localhostUrl, host);
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
    // ── Fast path: CID cache hit → iframe to cid.app.dot.li ──
    const cachedCid = await getCachedCid(label);
    if (cachedCid !== null) {
      log.warn(`[dot.li perf] CID cache HIT: ${cachedCid} (${elapsed(T0)})`);
      setShieldState("validating");
      const { renderAppSubdomain } = await renderChunkPromise;
      await renderAppSubdomain(cachedCid, label);

      performance.mark("dotli:main:end");
      log.warn(`[dot.li perf] === TOTAL (fast path): ${dur(T0)} ===`);

      // Verify the cached CID against the chain in the background.
      // If the on-chain CID has changed, show an update banner.
      verifyCachedCid(label, cachedCid, protocolChunkPromise);
      return;
    }
    log.warn(`[dot.li perf] CID cache MISS (${elapsed(T0)})`);

    // ── Full resolution path ──

    log.warn(`[dot.li perf] Awaiting protocol chunk... (${elapsed(T0)})`);
    const { resolveDotNameRemote, resolveOwnerRemote } =
      await protocolChunkPromise;
    log.warn(
      `[dot.li perf] Protocol chunk loaded (${dur(protocolChunkStart)}, ${elapsed(T0)})`,
    );
    populateOwner(resolveOwnerRemote, label);

    performance.mark("dotli:resolve:start");
    const resolveStart = performance.now();
    const cid = await resolveDotNameRemote(label, (msg: string) => {
      showStatus(msg);
    });
    performance.mark("dotli:resolve:end");
    log.warn(
      `[dot.li perf] Resolution done (${dur(resolveStart)}, ${elapsed(T0)}) → ${cid ?? "null"}`,
    );

    if (cid === null) {
      showError(
        `${label}.dot`,
        "This domain has no content set. The owner needs to publish content to the Bulletin Chain and set the content hash.",
      );
      return;
    }

    requestIdleCallback(() => {
      void setCachedCid(label, cid);
    });

    setShieldState("verified");

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

void main();
