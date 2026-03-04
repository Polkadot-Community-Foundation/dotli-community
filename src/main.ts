// dot.li — Universal Viewer entry point
//
// Flow: parse URL → resolve .dot name via smoldot → fetch content from Bulletin → render in iframe

import type { ArchiveFiles } from "./archive";
import { showStatus, showError, showLanding } from "./ui";
import { initAuth } from "./auth";
import { initTopBar } from "./topbar";

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
    }, 3_000);
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
    await navigator.serviceWorker.register("/sw.js");

    // Wait until the SW is controlling this page (needed by renderArchive)
    if (navigator.serviceWorker.controller) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Service Worker not available after 10s"));
      }, 10_000);
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

// Module-level references for cleanup handler
let destroyClientFn: (() => void) | null = null;
let destroyHeliaFn: (() => Promise<void>) | null = null;

async function main(): Promise<void> {
  performance.mark("dotli:main:start");

  // Initialize auth adapter and top bar UI
  performance.mark("dotli:auth:start");
  initAuth();
  performance.mark("dotli:auth:end");

  initTopBar();

  const label = parseDotLabel();

  if (label === null) {
    showLanding();
    performance.mark("dotli:main:end");
    return;
  }

  // Start loading the resolve chunk immediately — the network request fires
  // now while we do synchronous DOM setup below. By the time we await it,
  // the chunk is already (partially) downloaded.
  const resolveChunkPromise = import("./resolve");

  // Show the .dot domain in the URL bar
  const urlBar = document.getElementById("topbar-url");
  if (urlBar === null) {
    return;
  }
  urlBar.innerHTML = `<div class="topbar-url-pill" id="url-pill"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg><span><span class="dot-domain">${label}</span><span class="dot-tld">.dot</span></span></div>`;

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
    // Start SW registration in parallel with resolution — SW is only needed
    // before rendering, not before resolving. This saves ~100-500ms.
    performance.mark("dotli:sw:start");
    const swReady = registerServiceWorker().then(() => {
      performance.mark("dotli:sw:end");
    });

    // Step 1: Resolve the .dot name to a CID via smoldot + dotNS
    // The chunk was already requested above (before DOM setup)
    performance.mark("dotli:resolve:start");
    const { resolveDotName, resolveOwner, destroyClient } =
      await resolveChunkPromise;
    destroyClientFn = destroyClient;
    const cid = await resolveDotName(label, showStatus);
    performance.mark("dotli:resolve:end");

    if (cid === null) {
      showError(
        `${label}.dot`,
        "This domain has no content set. The owner needs to publish content to the Bulletin Chain and set the content hash.",
      );
      return;
    }

    // Ensure SW is ready before rendering (it was started in parallel above)
    await swReady;

    // Step 2: Fetch content + resolve owner in parallel
    // Fire-and-forget: populates the domain popover when ready
    void resolveOwner(label)
      .then((owner) => {
        const el = document.getElementById("domain-popover-owner");
        if (el === null) {
          return;
        }
        if (owner !== null) {
          const short = `${owner.slice(0, 6)}...${owner.slice(-4)}`;
          el.classList.remove("loading");
          el.innerHTML = `${short}<button class="domain-popover-copy" title="Copy address"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`;
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

    // Step 2b: Check SW cache before fetching
    performance.mark("dotli:cache-check:start");
    const cachedFiles = await getCachedArchive(label, cid);
    performance.mark("dotli:cache-check:end");

    if (cachedFiles) {
      showStatus("Rendering (cached)...");
      performance.mark("dotli:render:start");
      const { renderArchive } = await import("./render");
      await renderArchive(cachedFiles, label, cid);
      performance.mark("dotli:render:end");
    } else {
      performance.mark("dotli:fetch:start");
      const { fetchArchive, destroyHelia } = await import("./fetch");
      destroyHeliaFn = destroyHelia;
      const result = await fetchArchive(cid, showStatus);
      performance.mark("dotli:fetch:end");

      // Step 3: Render in sandboxed iframe
      showStatus("Rendering...");
      performance.mark("dotli:render:start");
      const { renderArchive, renderContent } = await import("./render");
      if (result.type === "archive") {
        await renderArchive(result.files, label, cid);
      } else {
        renderContent(result.content, label);
      }
      performance.mark("dotli:render:end");
    }
    performance.mark("dotli:main:end");
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
