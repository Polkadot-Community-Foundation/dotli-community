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

import "@dotli/ui/styles.css";
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
import { getCachedCid, setCachedCid } from "@dotli/storage/cid-cache";
import { dur, elapsed } from "@dotli/shared/perf";
import { BASE_DOMAIN, SITE_ID } from "@dotli/config/config";
import { log } from "@dotli/shared/log";
import { serializeError } from "@dotli/shared/errors";
import { escapeHtml } from "@dotli/shared/html";
import { showNotification } from "@dotli/ui/notification";
import {
  getMode,
  isP2pMode,
  isVerifiedSession,
  getCacheSettings,
  getChainBackend,
  getContentBackend,
} from "@dotli/config/mode";

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

// ── Desktop download banner ──────────────────────────────
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
  const chainBackend = getChainBackend();
  const contentBackend = getContentBackend();
  const cacheSettings = getCacheSettings();
  log.warn(
    `[dot.li perf] mode=${mode} chain=${chainBackend} content=${contentBackend}`,
  );
  // Registers the session's mode + backends + cache flags as default
  // attributes so every subsequent metric carries them.
  m.setDefaults({
    dotli_mode: mode,
    chain_backend: chainBackend,
    content_backend: contentBackend,
    skip_cid_cache: String(cacheSettings.skipCidCache),
    skip_archive_cache: String(cacheSettings.skipArchiveCache),
  });

  // Pre-warm the protocol iframe for every chain backend so sandboxed apps
  // that call `chainConnect` have a handler waiting on the other side. The
  // submode mapping is 1:1 with the chain backend; the content backend is
  // orthogonal and doesn't affect protocol submode.
  //   smoldot-shared-worker → "shared-worker"
  //   smoldot-direct        → "direct"
  //   rpc                   → "rpc"
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

  // Shield is driven by the split backends, not the legacy preset. A mixed
  // session (chain=smoldot + content=gateway, or chain=rpc + content=p2p)
  // resolves to "validating" because part of the data path is delegated to
  // a trusted provider — `isVerifiedSession` is the one rule that decides.
  const shieldState: "verified" | "validating" = isVerifiedSession(
    chainBackend,
    contentBackend,
  )
    ? "verified"
    : "validating";

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

      // After ~10s of slow sync, offer an explicit hand-off to the settings
      // popover rather than silently switching modes. Mode changes must be
      // active user choices — a button that rewrites localStorage and
      // reloads would be silent substitution. Instead, open the popover
      // with the current mode highlighted so the user picks.
      // 10 s matches the slowest of the major P2P-path slow-hint thresholds
      // that users actually hit (Resolving = 10 s, Adding Paseo relay chain
      // = 10 s) so the "Change settings" button arrives together with the
      // explanatory hint text instead of showing up 5 s before it.
      const gatewayBtnTimer = setTimeout(() => {
        const hint = document.getElementById("loading-hint");
        if (hint !== null) {
          const btn = document.createElement("button");
          btn.className = "loading-gateway-btn";
          btn.textContent = "Change settings";
          btn.title = "Open settings to change resolution mode";
          btn.addEventListener("click", (ev) => {
            // Stop propagation — the document-level click handler in the
            // topbar closes open popovers when the click target is outside
            // them, which would slam our popover shut immediately after we
            // opened it.
            ev.stopPropagation();
            openModePopover();
          });
          // Append *alongside* any existing hint text span (produced by
          // `showStatus` at the same threshold) instead of wiping it — the
          // button and the hint now co-exist in the same row.
          hint.appendChild(btn);
          hint.classList.add("visible");
        }
      }, 10000);

      const { resolveDotNameRemote, resolveOwnerRemote } =
        await import("@dotli/protocol/client");
      const { statusToPhase } = await import("@dotli/resolver/resolve");
      populateOwner(resolveOwnerRemote, label);
      cid = await resolveDotNameRemote(label, (msg: string) => {
        // Progress events arrive as opaque strings across the iframe
        // boundary. The resolver package owns the authoritative
        // mapping from status text → `ResolvePhase`; we defer to it
        // instead of maintaining a parallel regex here.
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

    // When the user disabled the CID cache, do NOT write to it.
    if (!cacheSettings.skipCidCache) {
      requestIdleCallback(() => {
        void setCachedCid(label, cid);
      });
    }

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
    // Report before rendering so monitoring always sees the root cause, even
    // if `showError()` itself throws (e.g. a DOM node is missing). The global
    // unhandled-rejection handler doesn't catch this — the try/catch here
    // already has. Carry the active dependency as a tag so Sentry + the
    // user-visible error both attribute the failure to the specific
    // dependency the chosen mode dialed.
    const dependency = isP2pMode(mode) ? "smoldot" : "asset-hub-rpc";
    captureException(err, {
      surface: "host_main_resolve",
      dependency,
      dotli_mode: mode,
    });
    // Walk the full `.cause` chain so the user sees not just the outermost
    // message but the underlying transport / decode reason too.
    const message = serializeError(err);
    showError("Resolution failed", `${message} (via ${dependency})`);
  }
}

void main();
