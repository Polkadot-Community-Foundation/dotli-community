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
import { showNotification } from "@dotli/ui/notification";

/** Session key: when set, the user has opted into the trusted RPC + gateway path. */
const PREFER_GATEWAY_KEY = "dotli:prefer-gateway";

/** Delay before revealing the "Use gateway instead" button during resolution. */
const GATEWAY_BUTTON_REVEAL_MS = 2500;

function isPreferGateway(): boolean {
  try {
    return sessionStorage.getItem(PREFER_GATEWAY_KEY) === "1";
  } catch {
    return false;
  }
}

function setPreferGateway(): void {
  try {
    sessionStorage.setItem(PREFER_GATEWAY_KEY, "1");
  } catch {
    /* storage may be blocked — in-memory flag via the promise below is enough */
  }
}

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
  log.warn(
    `[dot.li resolve] background: verifying cached CID for ${label}.dot via smoldot (trustless light-client)`,
  );
  void protocolChunkPromise
    .then(async ({ resolveDotNameRemote }) => {
      const chainCid = await resolveDotNameRemote(label);
      if (chainCid !== null && chainCid !== cachedCid) {
        log.warn(
          `[dot.li resolve] background: smoldot returned different CID — cached=${cachedCid}, chain=${chainCid}`,
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
        log.warn(
          `[dot.li resolve] background: smoldot confirmed cached CID matches chain for ${label}.dot`,
        );
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

interface GatewayHandle {
  /** Promise that resolves to a CID once the user picks the trusted-RPC path. */
  resolvePromise: Promise<string | null>;
  /** Hide the button (no-op if already hidden). */
  hideButton: () => void;
  /** Remove listeners and pending timers (safe to call multiple times). */
  dispose: () => void;
}

/**
 * Wire up the "Use gateway instead" button shown during the slow resolution
 * path. Returns a promise that only resolves if the user explicitly opts
 * into the trusted RPC path — otherwise it stays pending forever so a
 * `Promise.race` with smoldot will never prematurely fall through.
 */
function installGatewayButton(label: string): GatewayHandle {
  const btn = document.getElementById(
    "loading-gateway",
  ) as HTMLButtonElement | null;

  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  let onClick: (() => void) | null = null;
  let disposed = false;

  const resolvePromise = new Promise<string | null>((resolve, reject) => {
    if (btn === null) {
      // No button in the DOM — this promise is never resolved.
      return;
    }

    // Reveal after a short delay so a fast resolution doesn't flash it.
    revealTimer = setTimeout(() => {
      btn.style.display = "";
    }, GATEWAY_BUTTON_REVEAL_MS);

    onClick = () => {
      // Freeze the button so repeated clicks can't fire twice.
      btn.disabled = true;
      btn.style.pointerEvents = "none";
      const span = btn.querySelector("span");
      if (span !== null) {
        span.textContent = "Switching to trusted source…";
      }

      setPreferGateway();
      m.count("host.gateway_opt_in");
      log.warn("[dot.li perf] User opted into trusted RPC path");
      showStatus("Switching to trusted source…");

      void import("@dotli/resolver/rpc-resolve").then(
        async ({ resolveDotNameViaRpc }) => {
          try {
            const result = await resolveDotNameViaRpc(label, (msg) => {
              showStatus(msg);
            });
            resolve(result);
          } catch (err: unknown) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
        (err: unknown) => {
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    };

    btn.addEventListener("click", onClick);
  });

  const hideButton = (): void => {
    if (btn !== null) {
      btn.style.display = "none";
    }
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    if (revealTimer !== null) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    if (btn !== null && onClick !== null) {
      btn.removeEventListener("click", onClick);
    }
    hideButton();
  };

  return { resolvePromise, hideButton, dispose };
}

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

  // Listen for status messages from the sandbox iframe so the loading
  // UI continues seamlessly from resolution into content fetching.
  listenForSandboxStatus();

  initPhases(["Starting", "Connecting", "Syncing", "Resolving"]);
  advancePhase(0);
  showStatus(`Resolving ${label}.dot`);

  try {
    // ── Fast path: CID cache hit → iframe to cid.app.dot.li ──
    const cachedCid = await getCachedCid(label);
    if (cachedCid !== null) {
      m.count(S.CACHE_HIT);
      log.warn(
        `[dot.li resolve] path=cache (local CID cache hit, no chain query yet) (${elapsed(T0)}) -> ${cachedCid}`,
      );
      setShieldState("validating");
      const { renderAppSubdomain } = await renderChunkPromise;
      await renderAppSubdomain(cachedCid, label, {
        preferGateway: isPreferGateway(),
      });
      // Deep path was forwarded to the product iframe — strip it so the URL bar doesn't show a stale path
      history.replaceState(null, "", "/");

      const totalMs = performance.now() - T0;
      m.measure(S.E2E_FAST, totalMs);
      m.distribution(S.E2E_FAST, totalMs);
      performance.mark("dotli:main:end");
      log.warn(`[dot.li perf] === TOTAL (fast path): ${dur(T0)} ===`);

      // Verify the cached CID against the chain in the background.
      // If the on-chain CID has changed, show an update banner.
      verifyCachedCid(label, cachedCid, protocolChunkPromise);
      return;
    }
    m.count(S.CACHE_MISS);
    log.warn(`[dot.li perf] CID cache MISS (${elapsed(T0)})`);

    // ── Full resolution path ──
    //
    // Two possible resolvers:
    //   A) smoldot/light-client via the protocol SharedWorker (trustless)
    //   B) direct JSON-RPC to a trusted Polkadot RPC node (faster, trusted)
    //
    // Decision: read the `smoldotEverSynced` flag that lives in the
    // protocol iframe's localStorage at `host.{BASE_DOMAIN}` (shared
    // across every `*.{BASE_DOMAIN}` subdomain since the iframe origin
    // is the same). The iframe posts it via a `hello` envelope at the
    // very top of its init — before any smoldot work — so the wait is
    // effectively just "iframe JS loaded".
    //
    //   flag === true  → path A: smoldot, wait as long as needed
    //                    (the "Use trusted source" button stays as an
    //                    escape hatch the user can click at any point).
    //   flag === false → path B: go straight to JSON-RPC.

    log.warn(`[dot.li perf] Awaiting protocol chunk... (${elapsed(T0)})`);
    const {
      resolveDotNameRemote,
      resolveOwnerRemote,
      waitForSmoldotEverSynced,
      getProtocolOrigin,
    } = await protocolChunkPromise;
    log.warn(
      `[dot.li perf] Protocol chunk loaded (${dur(protocolChunkStart)}, ${elapsed(T0)})`,
    );

    let smoldotWarm = false;
    try {
      smoldotWarm = await waitForSmoldotEverSynced();
      log.warn(
        `[dot.li resolve] smoldot-ever-synced flag (from ${getProtocolOrigin()}): ${String(smoldotWarm)} (${elapsed(T0)})`,
      );
    } catch (err: unknown) {
      log.warn(
        `[dot.li resolve] could not read smoldot-ever-synced flag — assuming cold: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const preferRpc = isPreferGateway() || !smoldotWarm;

    performance.mark("dotli:resolve:start");
    const resolveStart = performance.now();
    const stopResolve = m.timer(S.RESOLVE_TOTAL);
    let cid: string | null;
    let resolvedVia: "smoldot" | "rpc";

    if (preferRpc) {
      const reason = isPreferGateway() ? "user opted in" : "smoldot cold";
      log.warn(
        `[dot.li resolve] path=json-rpc (trusted node, reason: ${reason}) (${elapsed(T0)})`,
      );
      m.count("host.resolve_prefer_rpc", {
        reason: isPreferGateway() ? "opt_in" : "smoldot_cold",
      });
      // Populate owner via RPC too so the popover still fills in. The
      // smoldot-based owner lookup would otherwise require warming up the
      // light client we are explicitly trying to avoid.
      const { resolveDotNameViaRpc, resolveOwnerViaRpc } =
        await import("@dotli/resolver/rpc-resolve");
      populateOwner(resolveOwnerViaRpc, label);
      cid = await resolveDotNameViaRpc(label, (msg: string) => {
        showStatus(msg);
      });
      resolvedVia = "rpc";
    } else {
      log.warn(
        `[dot.li resolve] path=smoldot (trustless light-client) (${elapsed(T0)})`,
      );
      populateOwner(resolveOwnerRemote, label);

      const gateway = installGatewayButton(label);

      // Tag each promise so we can log which source actually won the race.
      // The iframe records the "ever synced" flag on its own side, so we
      // don't need to mirror it from here.
      const smoldotTagged = resolveDotNameRemote(label, (msg: string) => {
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
      }).then((value) => ({ via: "smoldot" as const, value }));
      const gatewayTagged = gateway.resolvePromise.then((value) => ({
        via: "rpc" as const,
        value,
      }));

      const winner = await Promise.race([smoldotTagged, gatewayTagged]);
      gateway.dispose();
      cid = winner.value;
      resolvedVia = winner.via;

      if (resolvedVia === "rpc") {
        log.warn(
          `[dot.li resolve] user clicked "Use trusted source" mid-resolution — switching to JSON-RPC (${elapsed(T0)})`,
        );
      }
    }

    stopStatusTick();
    stopResolve();
    performance.mark("dotli:resolve:end");
    const sourceLabel =
      resolvedVia === "rpc"
        ? "JSON-RPC (trusted node)"
        : "smoldot (trustless light-client)";
    log.warn(
      `[dot.li resolve] RESOLVED ${label}.dot via ${sourceLabel} in ${dur(resolveStart)} (total ${elapsed(T0)}) -> ${cid ?? "null"}`,
    );
    m.tag("resolve_source", resolvedVia);

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

    if (resolvedVia === "rpc") {
      // RPC is a trusted (not trustless) source. Keep the shield yellow
      // until smoldot can independently confirm the on-chain CID, then
      // verifyCachedCid() will flip it to green (or red + banner on mismatch).
      setShieldState("validating");
      verifyCachedCid(label, cid, protocolChunkPromise);
    } else {
      setShieldState("verified");
    }

    // Render: iframe to cid.app.dot.li
    const { renderAppSubdomain } = await renderChunkPromise;
    await renderAppSubdomain(cid, label, {
      preferGateway: isPreferGateway(),
    });

    const totalMs = performance.now() - T0;
    m.measure(S.E2E_SLOW, totalMs);
    m.distribution(S.E2E_SLOW, totalMs);
    // Deep path was forwarded to the product iframe — strip it so the URL bar doesn't show a stale path
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
