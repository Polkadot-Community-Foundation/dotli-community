// dot.li — Universal Viewer entry point
//
// Flow: parse URL → resolve .dot name via smoldot → fetch content from Bulletin → render in iframe

import { resolveDotName, resolveOwner, destroyClient } from "./resolve";
import { fetchArchive, destroyHelia } from "./fetch";
import {
  renderContent,
  renderArchive,
  showStatus,
  showError,
  showLanding,
} from "./render";
import { initAuth } from "./auth";
import { initTopBar } from "./topbar";

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
  if (!("serviceWorker" in navigator)) return;

  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    // Wait for the SW to be active
    if (reg.active) return;
    await new Promise<void>((resolve) => {
      const sw = reg.installing || reg.waiting;
      if (!sw) return resolve();
      sw.addEventListener("statechange", () => {
        if (sw.state === "activated") resolve();
      });
    });
  } catch (err) {
    console.warn("[dot.li] Service worker registration failed:", err);
  }
}

async function main(): Promise<void> {
  // Initialize auth adapter, top bar UI, and service worker (non-blocking)
  initAuth();
  initTopBar();
  registerServiceWorker();

  const label = parseDotLabel();

  if (!label) {
    showLanding();
    return;
  }

  // Show the .dot domain in the URL bar
  const urlBar = document.getElementById("topbar-url")!;
  urlBar.innerHTML = `<div class="topbar-url-pill" id="url-pill"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg><span><span class="dot-domain">${label}</span><span class="dot-tld">.dot</span></span></div>`;

  // Domain info popover toggle
  const urlPill = document.getElementById("url-pill")!;
  const domainPopover = document.getElementById("domain-popover")!;
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
    // Step 1: Resolve the .dot name to a CID via smoldot + dotNS
    const cid = await resolveDotName(label, showStatus);

    if (!cid) {
      showError(
        `${label}.dot`,
        "This domain has no content set. The owner needs to publish content to the Bulletin Chain and set the content hash.",
      );
      return;
    }

    // Step 2: Fetch content + resolve owner in parallel
    // Fire-and-forget: populates the domain popover when ready
    void resolveOwner(label)
      .then((owner) => {
        const el = document.getElementById("domain-popover-owner")!;
        if (owner) {
          const short = `${owner.slice(0, 6)}...${owner.slice(-4)}`;
          el.classList.remove("loading");
          el.innerHTML = `${short}<button class="domain-popover-copy" title="Copy address"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`;
          el.querySelector(".domain-popover-copy")!.addEventListener(
            "click",
            (e) => {
              e.stopPropagation();
              navigator.clipboard.writeText(owner);
              const btn = e.currentTarget as HTMLElement;
              btn.style.color = "#4ade80";
              btn.style.borderColor = "#4ade80";
              setTimeout(() => {
                btn.style.color = "";
                btn.style.borderColor = "";
              }, 1000);
            },
          );
        } else {
          el.textContent = "Unknown";
          el.classList.remove("loading");
        }
      })
      .catch(() => {
        const el = document.getElementById("domain-popover-owner")!;
        el.textContent = "Unavailable";
        el.classList.remove("loading");
      });

    const result = await fetchArchive(cid, showStatus);

    // Step 3: Render in sandboxed iframe
    showStatus("Rendering...");
    if (result.type === "archive") {
      await renderArchive(result.files, label);
    } else {
      renderContent(result.content, label);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showError("Resolution failed", message);
  }
}

// Cleanup on page unload
window.addEventListener("beforeunload", () => {
  destroyClient();
  destroyHelia();
});

main();
