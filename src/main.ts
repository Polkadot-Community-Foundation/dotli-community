// dot.li — Universal Viewer entry point
//
// Flow: parse URL → resolve .dot name via smoldot → fetch content from Bulletin → render in iframe

// Polyfill for Safari < 18.4 which lacks requestIdleCallback
if (typeof globalThis.requestIdleCallback !== "function") {
  globalThis.requestIdleCallback = (cb: IdleRequestCallback): number =>
    setTimeout(() => {
      cb({ didTimeout: false, timeRemaining: () => 50 } as IdleDeadline);
    }, 1) as unknown as number;
}

import type { ArchiveFiles } from "./archive";
import { showStatus, showError, showLanding } from "./ui";
import { initTopBar } from "./topbar";
import { getCachedCid, setCachedCid } from "./cid-cache";
import { dur } from "./perf";
import { TIMEOUTS } from "./config";

const T0 = performance.now();
function elapsed(): string {
  return `+${((performance.now() - T0) / 1000).toFixed(3)}s`;
}

/**
 * Check if the Service Worker has a cached archive for this domain.
 * Returns the cached files if the CID matches, null otherwise.
 */
async function getCachedArchive(
  domain: string,
  cid: string,
): Promise<ArchiveFiles | null> {
  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    return null;
  }

  return new Promise<ArchiveFiles | null>((resolve) => {
    const timeout = setTimeout(() => {
      resolve(null);
    }, TIMEOUTS.SW_CACHE_LOOKUP);
    const channel = new MessageChannel();

    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timeout);
      const msg = event.data as {
        found?: boolean;
        cid?: string;
        files?: Record<string, ArrayBuffer | Uint8Array>;
      };
      if (msg.found === true && msg.cid === cid && msg.files !== undefined) {
        // Normalize ArrayBuffers from IndexedDB to Uint8Arrays
        const raw = msg.files;
        const files: ArchiveFiles = {};
        for (const [path, data] of Object.entries(raw)) {
          files[path] =
            data instanceof Uint8Array ? data : new Uint8Array(data);
        }
        resolve(files);
      } else {
        resolve(null);
      }
    };

    controller.postMessage({ type: "SW_CACHE_LOOKUP_EVENT", domain }, [
      channel.port2,
    ]);
  });
}

/**
 * Extract the .dot label from the current hostname.
 *
 * Examples:
 *   "myapp.dot.li"        → "myapp"
 *   "myapp.localhost"      → "myapp"    (local dev)
 *   "dot.li"              → null        (landing page)
 *   "localhost"            → null        (landing page)
 */
function parseDotLabel(): string | null {
  const hostname = window.location.hostname;

  // Production: name.dot.li
  if (hostname.endsWith(".dot.li")) {
    const label = hostname.slice(0, -".dot.li".length);
    return label || null;
  }

  // Local dev: name.localhost
  if (hostname.endsWith(".localhost")) {
    const label = hostname.slice(0, -".localhost".length);
    return label || null;
  }

  return null;
}

/**
 * Register the Service Worker for multi-file SPA support.
 * The SW intercepts requests under /dotli-app/ and serves files from an in-memory archive.
 */
async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    const swUrl = import.meta.env.DEV ? "/src/sw.ts" : "/sw.js";
    await navigator.serviceWorker.register(swUrl, {
      type: "module",
      scope: "/",
    });

    // Wait until the SW is controlling this page (needed by renderArchive)
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
      // Nudge the SW to claim if it's active but hasn't claimed yet
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
    console.warn("[dot.li] Service worker registration failed:", err);
  }
}

/**
 * Set the verification shield state in the URL pill.
 *   "validating" — yellow: loaded from cache, checking on-chain
 *   "verified"   — green: on-chain CID matches cached version
 *   "stale"      — red: on-chain CID differs (content outdated)
 */
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
        console.warn(
          `[dot.li] CID mismatch: gateway=${gatewayCid}, chain=${chainCid}`,
        );
        requestIdleCallback(() => {
          void setCachedCid(label, chainCid);
        });
        setShieldState("stale");
        showUpdateBanner();
      } else if (chainCid !== null) {
        console.warn("[dot.li] Gateway CID verified by chain");
        setShieldState("verified");
      }
    })
    .catch(() => {
      /* fire-and-forget */
    });
}

import type * as RenderModule from "./render";
import type * as FetchModule from "./fetch";
type RenderChunk = typeof RenderModule;
type FetchChunk = typeof FetchModule;

/**
 * Fetch content (from SW cache or P2P) and render it.
 */
async function fetchAndRender(
  label: string,
  cid: string,
  swReady: Promise<void>,
  heliaWarmup: Promise<unknown>,
  renderChunkPromise: Promise<RenderChunk>,
  fetchChunkPromise: Promise<FetchChunk>,
): Promise<void> {
  // Ensure SW is ready before cache check / rendering
  console.warn(`[dot.li perf] Awaiting SW ready... (${elapsed()})`);
  await swReady;
  console.warn(`[dot.li perf] SW ready (${elapsed()})`);

  // Check SW cache before fetching
  performance.mark("dotli:cache-check:start");
  const cacheStart = performance.now();
  const cachedFiles = await getCachedArchive(label, cid);
  performance.mark("dotli:cache-check:end");
  console.warn(
    `[dot.li perf] Cache check done (${dur(cacheStart)}) → ${cachedFiles !== null ? "HIT" : "MISS"} (${elapsed()})`,
  );

  if (cachedFiles) {
    showStatus("Rendering (cached)...");
    performance.mark("dotli:render:start");
    const renderStart = performance.now();
    const { renderArchive } = await renderChunkPromise;
    await renderArchive(cachedFiles, label, cid);
    performance.mark("dotli:render:end");
    console.warn(
      `[dot.li perf] Render done — cached (${dur(renderStart)}, ${elapsed()})`,
    );
    return;
  }

  // Fetch via P2P
  performance.mark("dotli:fetch:start");
  const fetchStart = performance.now();
  console.warn(`[dot.li perf] Loading fetch chunk... (${elapsed()})`);
  const { fetchArchive, destroyHelia } = await fetchChunkPromise;
  console.warn(`[dot.li perf] Fetch chunk loaded (${elapsed()})`);
  destroyHeliaFn = destroyHelia;
  const heliaWait = performance.now();
  await heliaWarmup;
  console.warn(
    `[dot.li perf] Helia P2P ready (waited ${dur(heliaWait)}, ${elapsed()})`,
  );
  const result = await fetchArchive(cid, showStatus);
  performance.mark("dotli:fetch:end");
  console.warn(
    `[dot.li perf] Content fetched (${dur(fetchStart)}, ${elapsed()}) → ${result.type}`,
  );

  // Render in sandboxed iframe
  showStatus("Rendering...");
  performance.mark("dotli:render:start");
  const renderStart = performance.now();
  const { renderArchive, renderContent } = await renderChunkPromise;
  if (result.type === "archive") {
    await renderArchive(result.files, label, cid);
  } else {
    await renderContent(result.content, label);
  }
  performance.mark("dotli:render:end");
  console.warn(`[dot.li perf] Render done (${dur(renderStart)}, ${elapsed()})`);
}

// ── Main ─────────────────────────────────────────────────────

// Module-level references for cleanup handler
let destroyClientFn: (() => void) | null = null;
let destroyHeliaFn: (() => Promise<void>) | null = null;

async function main(): Promise<void> {
  performance.mark("dotli:main:start");
  console.warn(`[dot.li perf] main() started (${elapsed()})`);

  // Pre-warm smoldot unconditionally — start downloading the resolve chunk
  // and kick off relay chain sync immediately. 99.9% of traffic is subdomain
  // requests, so the cost of loading this on the landing page is negligible.
  const resolveChunkStart = performance.now();
  const resolveChunkPromise = import("./resolve");
  void resolveChunkPromise.then(({ getSmoldot, getRelayChain }) => {
    getSmoldot();
    void getRelayChain();
  });

  // Initialize top bar UI (auth is lazy-loaded inside topbar when needed)
  const t0 = performance.now();
  initTopBar();
  console.warn(`[dot.li perf] initTopBar() done (${dur(t0)})`);

  const label = parseDotLabel();

  if (label === null) {
    console.warn(`[dot.li perf] Landing page — no subdomain (${elapsed()})`);
    showLanding();
    performance.mark("dotli:main:end");
    return;
  }

  console.warn(`[dot.li perf] Subdomain detected: "${label}" (${elapsed()})`);

  // Pre-load chunks in parallel (overlap with CID cache check + resolution)
  const gatewayChunkPromise = import("./gateway-resolve");
  void gatewayChunkPromise.catch(() => {
    /* fire-and-forget */
  });
  const renderChunkPromise = import("./render");
  void renderChunkPromise.catch(() => {
    /* fire-and-forget */
  });
  const swProviderChunkPromise = import("./sw-provider");
  void swProviderChunkPromise.catch(() => {
    /* fire-and-forget */
  });
  const fetchChunkPromise = import("./fetch");
  void fetchChunkPromise.catch(() => {
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
  // Close popover when iframe gets focus (clicking into the app content)
  window.addEventListener("blur", () => {
    domainPopover.classList.remove("open");
  });

  showStatus(`Resolving ${label}.dot...`);

  try {
    // Start SW registration in parallel — SW is only needed before rendering,
    // so it runs concurrently with chunk loading + smoldot resolution
    performance.mark("dotli:sw:start");
    const swStart = performance.now();
    console.warn(`[dot.li perf] SW registration started (${elapsed()})`);

    // Detect cold start: no controller means SW is being freshly registered.
    // Tell resolve.ts to skip trySwSmoldot() (avoids 500ms timeout).
    if (!navigator.serviceWorker.controller) {
      void resolveChunkPromise.then(({ markFreshSwRegistration }) => {
        markFreshSwRegistration();
      });
    }

    const swReady = registerServiceWorker().then(() => {
      performance.mark("dotli:sw:end");
      console.warn(
        `[dot.li perf] SW registration done (${dur(swStart)}, ${elapsed()})`,
      );
    });

    // Pre-create iframe element while we resolve + fetch (saves ~50ms later)
    renderChunkPromise
      .then(({ prepareIframe }) => {
        prepareIframe();
      })
      .catch(() => {
        /* fire-and-forget */
      });

    // ── Fast path: CID cache + SW archive cache ──
    // On repeat visits, render from the cached CID instantly (<500ms)
    // and validate via smoldot in the background.
    const cachedCid = await getCachedCid(label);
    if (cachedCid !== null) {
      console.warn(`[dot.li perf] CID cache HIT: ${cachedCid} (${elapsed()})`);
      await swReady;
      const cachedFiles = await getCachedArchive(label, cachedCid);
      if (cachedFiles) {
        console.warn(`[dot.li perf] SW archive cache HIT (${elapsed()})`);
        showStatus("Rendering (cached)...");
        setShieldState("validating");
        performance.mark("dotli:render:start");
        const renderStart = performance.now();
        const { renderArchive } = await renderChunkPromise;
        await renderArchive(cachedFiles, label, cachedCid);
        performance.mark("dotli:render:end");
        console.warn(
          `[dot.li perf] Render done — fast path (${dur(renderStart)}, ${elapsed()})`,
        );
        performance.mark("dotli:main:end");
        console.warn(`[dot.li perf] === TOTAL (fast path): ${dur(T0)} ===`);

        // Background: validate CID is still current
        resolveChunkPromise
          .then(({ resolveDotName, resolveOwner, destroyClient }) => {
            destroyClientFn = destroyClient;
            populateOwner(resolveOwner, label);
            resolveDotName(label).then((freshCid) => {
              if (freshCid !== null && freshCid !== cachedCid) {
                console.warn(
                  `[dot.li] CID changed: ${cachedCid} → ${freshCid}`,
                );
                requestIdleCallback(() => {
                  void setCachedCid(label, freshCid);
                });
                setShieldState("stale");
                showUpdateBanner();
              } else if (freshCid !== null) {
                // Same CID — refresh timestamp
                requestIdleCallback(() => {
                  void setCachedCid(label, freshCid);
                });
                setShieldState("verified");
              }
            }, console.error);
          })
          .catch(console.error);
        return;
      }
      console.warn(`[dot.li perf] SW archive cache MISS (${elapsed()})`);
    } else {
      console.warn(`[dot.li perf] CID cache MISS (${elapsed()})`);
    }

    // ── Full resolution path (first visit or cache miss) ──

    // Pre-warm Helia P2P: start dialing Bulletin peers in parallel with
    // resolution. Peer connections (~2.3s) don't need the CID.
    console.warn(`[dot.li perf] Pre-warming Helia P2P... (${elapsed()})`);
    const heliaWarmup = fetchChunkPromise.then(
      ({ ensureHelia, destroyHelia }) => {
        destroyHeliaFn = destroyHelia;
        return ensureHelia();
      },
    );
    void heliaWarmup.catch(() => {
      /* fire-and-forget */
    });

    // Check if SW smoldot is already synced (lukewarm same-origin revisit).
    // If ready, skip the gateway entirely — SW smoldot resolves instantly.
    const { isSwSmoldotReady } = await swProviderChunkPromise;
    const swSmoldotReady = await isSwSmoldotReady();

    // Start gateway resolution only if SW smoldot is not ready
    performance.mark("dotli:resolve:start");
    let gatewayPromise: Promise<string | null>;
    if (swSmoldotReady) {
      console.warn(
        `[dot.li perf] SW smoldot ready — skipping gateway (${elapsed()})`,
      );
      gatewayPromise = Promise.resolve(null);
    } else {
      console.warn(
        `[dot.li perf] Starting gateway + smoldot resolve... (${elapsed()})`,
      );
      gatewayPromise = gatewayChunkPromise
        .then(({ resolveViaGateway }) => resolveViaGateway(label))
        .catch(() => null as string | null);
    }

    // Await resolve chunk for smoldot path (already loading since top of main)
    console.warn(`[dot.li perf] Awaiting resolve chunk... (${elapsed()})`);
    const { resolveDotName, resolveOwner, destroyClient } =
      await resolveChunkPromise;
    console.warn(
      `[dot.li perf] Resolve chunk loaded (${dur(resolveChunkStart)}, ${elapsed()})`,
    );
    destroyClientFn = destroyClient;
    populateOwner(resolveOwner, label);

    // Start smoldot resolution in parallel with gateway
    let showSmoldotStatus = true;
    const smoldotPromise = resolveDotName(label, (msg: string) => {
      if (showSmoldotStatus) {
        showStatus(msg);
      }
    });

    // Race: first non-null CID wins
    const resolveStart = performance.now();
    const winner = await raceResolvers(gatewayPromise, smoldotPromise);
    performance.mark("dotli:resolve:end");
    console.warn(
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

    // Cache the resolved CID for future fast-path visits
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

    await fetchAndRender(
      label,
      cid,
      swReady,
      heliaWarmup,
      renderChunkPromise,
      fetchChunkPromise,
    );
    performance.mark("dotli:main:end");
    console.warn(`[dot.li perf] === TOTAL: ${dur(T0)} ===`);
  } catch (err) {
    performance.mark("dotli:main:end");
    const message = err instanceof Error ? err.message : String(err);
    showError("Resolution failed", message);
  }
}

// Cleanup on page unload
window.addEventListener("beforeunload", () => {
  destroyClientFn?.();
  if (destroyHeliaFn) {
    void destroyHeliaFn();
  }
});

void main();
