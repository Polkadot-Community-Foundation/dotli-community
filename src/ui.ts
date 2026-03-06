// dot.li — Pure DOM UI helpers
//
// Status messages, error states, and landing page.
// No heavy dependencies — kept in the eager bundle.

import { getRecentLabels, addRecentLabel } from "./cid-cache";

const app = document.getElementById("app") ?? document.body;

function dotUrl(label: string): string {
  const host = window.location.hostname;
  if (host.endsWith(".localhost") || host === "localhost") {
    return `${window.location.protocol}//${label}.localhost:${window.location.port}`;
  }
  // GitHub Pages or other non-dot.li hosts: use path-based routing
  if (host !== "dot.li") {
    // Strip any existing .dot segment and trailing slash from the base path
    const base = window.location.pathname
      .replace(/\/[^/]+\.dot(?:\/.*)?$/, "")
      .replace(/\/$/, "");
    return `${window.location.origin}${base}/${label}.dot`;
  }
  return `https://${label}.dot.li`;
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
    <div style="display:flex;align-items:center;justify-content:center;min-height:calc(100dvh - 40px);font-family:system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;">
      <div style="max-width:480px;padding:2rem;text-align:center;">
        <h1 style="font-size:1.5rem;color:#fff;margin-bottom:0.75rem;">${title}</h1>
        <p style="color:#888;line-height:1.6;">${detail}</p>
        <div style="margin-top:1.5rem;display:inline-flex;gap:0.5rem;font-size:0.8rem;color:#555;">
          <span style="padding:0.25rem 0.6rem;border:1px solid #222;border-radius:4px;">dot.li</span>
          <span style="padding:0.25rem 0.6rem;border:1px solid #222;border-radius:4px;">dotNS</span>
          <span style="padding:0.25rem 0.6rem;border:1px solid #222;border-radius:4px;">Bulletin</span>
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
    <div style="display:flex;flex-direction:column;align-items:center;min-height:100dvh;font-family:system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;padding:2rem;">
      <div style="position:absolute;top:16px;right:16px;" id="landing-auth"></div>
      <div style="flex:1;display:flex;align-items:center;justify-content:center;">
      <div style="text-align:center;max-width:520px;">
        <h1 style="font-size:2.8rem;font-weight:700;color:#fff;letter-spacing:-0.03em;margin-bottom:0.5rem;">
          dot<span style="color:#555;">.li</span>
        </h1>
        <p style="font-size:1.05rem;color:#888;line-height:1.7;margin-bottom:1.5rem;">
          The decentralized web, in your browser.<br>
          <span style="font-size:0.85rem;color:#666;">Search below or go directly to <span style="color:#aaa;">name</span><span style="color:#555;">.dot.li</span></span>
        </p>
        <form id="dotli-nav-form" style="display:flex;align-items:center;justify-content:center;margin-bottom:2rem;" autocomplete="off">
          <div style="display:flex;align-items:center;background:#111;border:1px solid #333;border-radius:10px;overflow:hidden;height:44px;width:100%;max-width:340px;transition:border-color 0.15s;" id="dotli-nav-bar">
            <input id="dotli-nav-input" type="text" placeholder="name" spellcheck="false" autocomplete="off" style="flex:1;background:transparent;border:none;outline:none;color:#fff;font-size:1rem;padding:0 0 0 16px;font-family:system-ui,sans-serif;height:100%;min-width:0;" />
            <span style="font-size:1rem;color:#888;font-weight:500;padding-right:12px;user-select:none;white-space:nowrap;">.dot</span>
            <button type="submit" style="display:flex;align-items:center;justify-content:center;width:40px;height:100%;background:transparent;border:none;border-left:1px solid #333;color:#666;cursor:pointer;transition:color 0.15s,background 0.15s;" aria-label="Go">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            </button>
          </div>
        </form>
        <div id="dotli-recent" style="display:none;margin-bottom:2rem;"></div>
      </div>
      </div>
      <div style="flex-shrink:0;padding:1.5rem 0;text-align:center;">
        <div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:1rem;">
          <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#4ade80;"></span>
          <span style="font-size:0.78rem;color:#666;">Resolved client-side via light client — no servers involved</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:0.5rem;font-size:0.72rem;color:#555;">
          <span style="padding:4px 10px;border:1px solid #222;border-radius:6px;">Polkadot</span>
          <span style="padding:4px 10px;border:1px solid #222;border-radius:6px;">Decentralized</span>
          <span style="padding:4px 10px;border:1px solid #222;border-radius:6px;">Trustless</span>
          <span style="padding:4px 10px;border:1px solid #222;border-radius:6px;">Client-side</span>
          <span style="padding:4px 10px;border:1px solid #222;border-radius:6px;">Light client</span>
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
    bar.style.borderColor = "#333";
  });
  input.addEventListener("input", () => {
    goBtn.style.color = input.value.trim() ? "#fff" : "#666";
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
    const url = dotUrl(name);
    void addRecentLabel(name).finally(() => {
      window.location.href = url;
    });
  });

  input.focus();

  // Move auth button to the landing page top-right
  const landingAuth = document.getElementById("landing-auth");
  const authButton = document.getElementById("auth-button");
  if (landingAuth && authButton) {
    landingAuth.appendChild(authButton);
  }

  // Show recently visited .dot sites
  const labels = getRecentLabels();
  if (labels.length > 0) {
    const container = document.getElementById("dotli-recent");
    if (container) {
      container.style.display = "block";
      const items = labels
        .map((label) => {
          return `<a href="${dotUrl(label)}" style="display:inline-flex;align-items:center;text-decoration:none;padding:6px 14px;background:#151515;border:1px solid #2a2a2a;border-radius:20px;transition:border-color 0.15s,background 0.15s;" onmouseover="this.style.borderColor='#444';this.style.background='#1a1a1a'" onmouseout="this.style.borderColor='#2a2a2a';this.style.background='#151515'">
            <span style="font-size:0.75rem;color:#999;white-space:nowrap;">${label}<span style="color:#555">.dot</span></span>
          </a>`;
        })
        .join("");
      container.innerHTML = `<div style="display:flex;flex-wrap:wrap;justify-content:center;gap:8px;">${items}</div>`;
    }
  }
}
