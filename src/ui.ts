// dot.li — Pure DOM UI helpers
//
// Status messages, error states, and landing page.
// No heavy dependencies — kept in the eager bundle.

import { getRecentLabels, addRecentLabel } from "./cid-cache";
import { BASE_DOMAIN } from "./config";

const app = document.getElementById("app") ?? document.body;

function dotUrl(label: string): string {
  const host = window.location.hostname;
  if (host.endsWith(".localhost") || host === "localhost") {
    return `${window.location.protocol}//${label}.localhost:${window.location.port}`;
  }
  // GitHub Pages or other non-matching hosts: use path-based routing
  if (host !== BASE_DOMAIN && !host.endsWith(`.${BASE_DOMAIN}`)) {
    const base = window.location.pathname
      .replace(/\/[^/]+\.dot(?:\/.*)?$/, "")
      .replace(/\/$/, "");
    return `${window.location.origin}${base}/${label}.dot`;
  }
  return `https://${label}.${BASE_DOMAIN}`;
}

/**
 * Show a status message in the loading UI.
 */
export function showStatus(message: string): void {
  const status = document.getElementById("status");
  if (status) {
    status.textContent = message;
  }
}

/**
 * Show an error state.
 */
export function showError(title: string, detail: string): void {
  app.innerHTML = `
    <div class="error-page">
      <div class="error-page-inner">
        <h1 class="error-page-title">${title}</h1>
        <p class="error-page-detail">${detail}</p>
        <div class="error-page-tags">
          <span class="error-page-tag">dot.li</span>
          <span class="error-page-tag">dotNS</span>
          <span class="error-page-tag">Bulletin</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Show the landing page (no subdomain detected).
 */
export function showLanding(): void {
  // Hide the topbar on the landing page
  const topbar = document.getElementById("topbar");
  if (topbar) {
    topbar.style.display = "none";
  }

  app.style.marginTop = "0";
  app.style.minHeight = "100dvh";
  app.innerHTML = `
    <div class="landing">
      <div class="landing-auth" id="landing-auth"></div>
      <div class="landing-center">
      <div class="landing-content">
        <h1 class="landing-title">
          ${BASE_DOMAIN.split(".")
            .map((p, i) =>
              i === 0 ? p : `<span class="landing-tld">.${p}</span>`,
            )
            .join("")}
        </h1>
        <p class="landing-subtitle">
          The decentralized web, in your browser.<br>
          <span class="landing-hint">Search below or go directly to <span class="landing-hint-name">name</span><span class="landing-tld">.${BASE_DOMAIN}</span></span>
        </p>
        <form id="dotli-nav-form" class="landing-nav-form" autocomplete="off">
          <div class="landing-search-bar" id="dotli-nav-bar">
            <input id="dotli-nav-input" class="landing-search-input" type="text" placeholder="name" spellcheck="false" autocomplete="off" />
            <span class="landing-dot-label">.dot</span>
            <button type="submit" class="landing-go-btn" aria-label="Go">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            </button>
          </div>
        </form>
        <div id="dotli-recent" class="landing-recent" hidden></div>
      </div>
      </div>
      <div class="landing-footer">
        <div class="landing-footer-status">
          <span class="landing-footer-dot"></span>
          <span class="landing-footer-text">Resolved client-side via light client — no servers involved</span>
        </div>
        <div class="landing-tags">
          <span class="landing-tag">Polkadot</span>
          <span class="landing-tag">Decentralized</span>
          <span class="landing-tag">Trustless</span>
          <span class="landing-tag">Client-side</span>
          <span class="landing-tag">Light client</span>
        </div>
      </div>
    </div>
  `;

  const form = document.getElementById(
    "dotli-nav-form",
  ) as HTMLFormElement | null;
  const input = document.getElementById(
    "dotli-nav-input",
  ) as HTMLInputElement | null;
  const bar = document.getElementById("dotli-nav-bar");
  if (!form || !input || !bar) {
    return;
  }

  const goBtn = form.querySelector<HTMLButtonElement>("button[type=submit]");
  if (!goBtn) {
    return;
  }

  input.addEventListener("focus", () => {
    bar.style.borderColor = "#e6007a";
  });
  input.addEventListener("blur", () => {
    bar.style.borderColor =
      document.documentElement.getAttribute("data-theme") === "light"
        ? "#ddd"
        : "#333";
  });
  input.addEventListener("input", () => {
    const isLight =
      document.documentElement.getAttribute("data-theme") === "light";
    const active = isLight ? "#333" : "#fff";
    const inactive = isLight ? "#999" : "#666";
    goBtn.style.color = input.value.trim() !== "" ? active : inactive;
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = input.value
      .trim()
      .toLowerCase()
      .replace(/\.dot$/, "");
    if (!name) {
      return;
    }
    // Tauri desktop: resolve via Rust backend and render inline
    if ("__TAURI_INTERNALS__" in window) {
      input.disabled = true;
      goBtn.style.opacity = "0.5";
      void import("./tauri-bridge").then(({ tauriResolveAndRender }) => {
        void addRecentLabel(name).finally(() => {
          void tauriResolveAndRender(name);
        });
      });
      return;
    }
    const url = dotUrl(name);
    void addRecentLabel(name).finally(() => {
      window.location.href = url;
    });
  });

  input.focus();

  // Move auth + theme toggle buttons to the landing page top-right
  const landingAuth = document.getElementById("landing-auth");
  const authButton = document.getElementById("auth-button");
  const themeToggle = document.getElementById("theme-toggle");
  if (landingAuth && authButton) {
    landingAuth.appendChild(authButton);
    if (themeToggle) {
      landingAuth.appendChild(themeToggle);
    }
  }

  // Show recently visited .dot sites
  const labels = getRecentLabels();
  if (labels.length > 0) {
    const container = document.getElementById("dotli-recent");
    if (container) {
      container.removeAttribute("hidden");
      const items = labels
        .map((label) => {
          return `<a href="${dotUrl(label)}" class="landing-recent-pill">
            <span class="landing-recent-label">${label}<span class="landing-tld">.dot</span></span>
          </a>`;
        })
        .join("");
      container.innerHTML = `<div class="landing-recent-list">${items}</div>`;
    }
  }
}
