// dot.li — Pure DOM UI helpers
//
// Status messages, error states, and landing page.
// No heavy dependencies — kept in the eager bundle.

import { getRecentLabels, addRecentLabel } from "./cid-cache";
import { BASE_DOMAIN, SITE_ID } from "./config";

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
    if (message.includes("\n")) {
      status.innerHTML = "";
      const parts = message.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          status.appendChild(document.createElement("br"));
        }
        status.appendChild(document.createTextNode(parts[i]));
      }
    } else {
      status.textContent = message;
    }
  }
}

/**
 * Show an error state with an optional retry button.
 */
export function showError(
  title: string,
  detail: string,
  onRetry?: () => void,
): void {
  app.innerHTML = `
    <div class="error-page">
      <div class="error-page-inner">
        <h1 class="error-page-title">${title}</h1>
        <p class="error-page-detail">${detail}</p>
        ${onRetry !== undefined ? '<button class="error-page-retry" id="error-retry-btn">Retry</button>' : ""}
        <div class="error-page-tags">
          <span class="error-page-tag">${SITE_ID}</span>
          <span class="error-page-tag">dotNS</span>
          <span class="error-page-tag">Bulletin</span>
        </div>
      </div>
    </div>
  `;

  if (onRetry !== undefined) {
    document
      .getElementById("error-retry-btn")
      ?.addEventListener("click", onRetry);
  }
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
        <div class="landing-logo">
          <svg width="48" height="54" viewBox="0 0 16 18" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M9.9873 14.1348C10.8273 14.1348 11.462 14.3911 11.6113 14.8604C11.8447 15.6051 10.7691 16.609 9.20801 17.1016C7.64706 17.5964 6.1908 17.3912 5.95508 16.6465C5.7363 15.9482 6.6685 15.0218 8.07227 14.5029L8.3584 14.4023C8.93466 14.2203 9.49501 14.1348 9.9873 14.1348ZM2.23828 9.9248C2.99193 9.9248 3.82268 10.226 4.52734 10.8213C5.85738 11.9442 6.23288 13.6886 5.36719 14.7158C4.50142 15.7428 2.71861 15.6629 1.38867 14.54C0.100568 13.4522 -0.291878 11.7823 0.47168 10.7451L0.551758 10.6465C0.957761 10.1634 1.5687 9.92482 2.23828 9.9248ZM15.1748 9.47949C15.2096 9.4795 15.2397 9.48415 15.2676 9.49805C15.6409 9.67081 15.4174 10.9618 14.7617 12.3789C14.1085 13.7956 13.2732 14.8041 12.8975 14.6318C12.5218 14.4591 12.7481 13.168 13.4014 11.751C14.0057 10.4413 14.7665 9.47949 15.1748 9.47949ZM3.42578 2.46387C3.9998 2.46387 4.55096 2.64366 4.9873 3.01953C6.10236 3.97675 6.07202 5.84169 4.92188 7.18164C3.76917 8.52404 1.93275 8.83452 0.817383 7.875C-0.297896 6.91782 -0.267461 5.05292 0.882812 3.71289C1.58276 2.8982 2.5345 2.46396 3.42578 2.46387ZM13.1631 2.80957C13.6391 2.80957 14.4071 3.79925 14.9531 5.15332C15.5458 6.62173 15.6526 7.96206 15.1953 8.14648C14.7355 8.33003 13.8845 7.29114 13.292 5.82324C12.6993 4.35719 12.5892 3.01463 13.0488 2.83008C13.0861 2.8161 13.1235 2.8096 13.1631 2.80957ZM7.82422 0C8.30483 0 8.83683 0.0896562 9.37109 0.276367C10.9576 0.829603 11.9799 2.02888 11.6582 2.95801C11.3362 3.88718 9.78886 4.19295 8.20215 3.63965C6.61582 3.08633 5.5943 1.88706 5.91602 0.958008C6.12834 0.341726 6.87931 6.04412e-05 7.82422 0Z" fill="currentColor"/>
          </svg>
        </div>
        <h1 class="landing-title">Polkadot Web</h1>
        <p class="landing-subtitle">
          The decentralized web, in your browser.<br>
          <span class="landing-hint">Search below or go directly to <span class="landing-hint-name">name</span><span class="landing-tld">.dot</span></span>
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
