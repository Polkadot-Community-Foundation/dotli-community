// dot.li — Tauri desktop bridge
//
// When running inside Tauri, resolves .dot names via the Rust backend
// (host-chain) and renders content in an iframe via the dotapp:// custom URI
// scheme. Assets are served directly from Rust memory — no encoding overhead.

import { log } from "./log";

interface ResolveResult {
  cid: string;
  owner: string | null;
  /** The .dot label that was resolved (same as the `name` argument). */
  app_id: string;
  /** File paths available in the asset store (no content). */
  files: string[];
}

export const IS_TAURI = "__TAURI_INTERNALS__" in window;

/** Escape a string for safe interpolation into HTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Resolve a .dot name via the Rust backend and render it in an iframe.
 * Called from the landing page form handler when running in Tauri.
 */
export async function tauriResolveAndRender(label: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");

  // Pre-warm container chunk import (overlaps with resolve network I/O)
  const containerChunkPromise = import("./container");
  void containerChunkPromise.catch(() => {
    /* pre-warm: ignore failures */
  });

  const app = document.getElementById("app") ?? document.body;

  // Restore the real topbar (landing page hides it and moves buttons out)
  const topbar = document.getElementById("topbar");
  if (topbar) {
    topbar.style.display = "";
    // Move auth + theme buttons back into topbar-right (landing page moves them)
    const topbarRight = topbar.querySelector(".topbar-right");
    const authBtn = document.getElementById("auth-button");
    const themeBtn = document.getElementById("theme-toggle");
    if (topbarRight) {
      if (authBtn) {
        topbarRight.appendChild(authBtn);
      }
      if (themeBtn) {
        topbarRight.appendChild(themeBtn);
      }
    }
  }

  // Set the URL pill with the domain name and a validating shield
  const urlBar = document.getElementById("topbar-url");
  if (urlBar) {
    urlBar.innerHTML = `<div class="topbar-url-pill" id="url-pill"><svg id="verification-shield" class="verification-shield validating" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2L3 7v5c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-9-5zm-1 14.59l-3.29-3.3 1.41-1.41L11 13.76l4.88-4.88 1.41 1.41L11 16.59z"/></svg><span><span class="dot-domain">${escapeHtml(label)}</span><span class="dot-tld">.dot</span></span></div>`;
  }

  // Show the standard dot.li loading spinner
  app.style.marginTop = "";
  app.style.minHeight = "";
  app.innerHTML = `<div class="loading"><h1>dot.li</h1><div class="spinner"></div><p id="status">Connecting...</p></div>`;

  const setStatus = (msg: string): void => {
    const el = document.getElementById("status");
    if (el) {
      el.textContent = msg;
    }
  };

  // Stage 1: "Connecting..." shown immediately (smoldot syncing happens in background)
  // Stage 2: Advance to "Looking up..." after a brief moment so the user sees progress
  const lookupTimer = setTimeout(() => {
    setStatus(`Looking up ${label}.dot...`);
  }, 600);

  let result: ResolveResult;
  try {
    result = await invoke<ResolveResult>("resolve_name", { name: label });
    clearTimeout(lookupTimer);
  } catch (err) {
    clearTimeout(lookupTimer);
    app.innerHTML = `<div class="error-page"><div class="error-page-inner"><h1 class="error-page-title">${escapeHtml(label)}.dot</h1><p class="error-page-detail">${escapeHtml(String(err))}</p><div class="error-page-tags"><span class="error-page-tag">dot.li</span><span class="error-page-tag">dotNS</span></div></div></div>`;
    return;
  }

  // Stage 3: Resolution done, loading content
  setStatus("Loading content...");

  // Update shield to verified
  const shield = document.getElementById("verification-shield");
  if (shield) {
    shield.classList.remove("validating");
    shield.classList.add("verified");
  }

  // Wire up domain info popover (same as web version in main.ts)
  const urlPill = document.getElementById("url-pill");
  const domainPopover = document.getElementById("domain-popover");
  if (urlPill && domainPopover) {
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

    // Populate popover fields
    const verificationEl = document.getElementById(
      "domain-popover-verification",
    );
    if (verificationEl) {
      verificationEl.textContent = "Verified on-chain";
    }

    const ownerEl = document.getElementById("domain-popover-owner");
    if (ownerEl) {
      ownerEl.textContent = result.owner ?? "Unknown";
      ownerEl.classList.remove("loading");
    }
  }

  // Find index.html — check exact match first, then look for it inside
  // a wrapper subdirectory (e.g. "appname/index.html" from `ipfs add -r`).
  let indexPath = "index.html";
  if (!result.files.includes(indexPath)) {
    const nested = result.files.find((f) => f.endsWith("/index.html"));
    if (nested !== undefined) {
      indexPath = nested;
    } else if (result.files.length === 0) {
      app.innerHTML = `<div class="error-page"><div class="error-page-inner"><h1 class="error-page-title">${escapeHtml(label)}.dot</h1><p class="error-page-detail">No index.html found in the resolved content.</p></div></div>`;
      return;
    }
    // If there are files but no index.html, let the protocol handler try —
    // the Rust fallback logic may serve another appropriate file.
  }

  app.innerHTML = "";
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";

  // Point the iframe at the dotapp:// URL — Rust serves all assets directly
  // from the in-memory asset store with correct Content-Type headers.
  const appUrl = `dotapp://${label}.dot/${indexPath}`;

  const iframe = document.createElement("iframe");
  // allow-same-origin is safe here: the iframe origin (dotapp://) differs from
  // the parent (tauri://localhost), so cross-origin restrictions still apply.
  // Without it the dApp loses access to localStorage, cookies, and fetch.
  iframe.sandbox.add(
    "allow-scripts",
    "allow-same-origin",
    "allow-forms",
    "allow-pointer-lock",
  );
  iframe.allow = "clipboard-write";
  iframe.style.cssText =
    "position:fixed;top:40px;left:0;width:100%;height:calc(100vh - 40px);border:none;margin:0;padding:0;";
  app.appendChild(iframe);

  // Wire up the container bridge — provides chain connections (smoldot),
  // accounts, signing, and scoped localStorage to the dApp.
  const { setupContainer } = await containerChunkPromise;
  setupContainer(iframe, appUrl, label);

  document.title = `${label}.dot`;
  log.warn(
    `[dot.li tauri] Rendered ${label}.dot — CID: ${result.cid}, ${String(result.files.length)} file(s)`,
  );
}
