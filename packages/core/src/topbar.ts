// dot.li — Top bar UI
//
// Manages the auth button, QR pairing modal, and user popover.
// All plain DOM manipulation — no framework.
//
// Auth module is lazy-loaded — the heavy host-papp, statement-store, and
// polkadot-api WS deps only load when a persisted session exists or the
// user clicks the auth button.

import type { AuthState } from "./auth";

// ── DOM refs ───────────────────────────────────────────────

function getElement(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`Element #${id} not found`);
  }
  return el;
}

// DOM refs are resolved lazily inside initTopBar() to avoid throwing
// at module scope if the HTML IDs change or the script loads early.
let authButton: HTMLElement;
let modalBackdrop: HTMLElement;
let modalQr: HTMLElement;
let modalClose: HTMLElement;
let userPopover: HTMLElement;
let userPopoverUsername: HTMLElement;
let userPopoverDisconnect: HTMLElement;

// Hexagon SVG for the logged-out state
const HEXAGON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`;

// Track the current QR payload to prevent stale canvas appends
let currentQrPayload: string | null = null;

// ── Lazy Auth Loading ─────────────────────────────────────

interface AuthModule {
  initAuth: () => void;
  getAuthState: () => AuthState;
  onAuthStateChange: (fn: (state: AuthState) => void) => () => void;
  startPairing: () => void;
  abortPairing: () => void;
  disconnect: () => Promise<void>;
  shortenName: (identity: {
    fullUsername: string | null;
    liteUsername: string;
  }) => string;
}

let authMod: AuthModule | null = null;

/**
 * Lazy-load and initialize the auth module. Subsequent calls return
 * the cached module immediately (initAuth is idempotent).
 */
async function ensureAuth(): Promise<AuthModule> {
  if (authMod) {
    return authMod;
  }
  authMod = (await import("./auth")) as AuthModule;
  authMod.initAuth();
  authMod.onAuthStateChange(renderAuthState);
  renderAuthState(authMod.getAuthState());
  return authMod;
}

// ── Theme Toggle ──────────────────────────────────────────

function getStoredTheme(): "light" | "dark" {
  const stored = localStorage.getItem("dotli-theme");
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  return "dark";
}

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.setAttribute("data-theme", theme);
  const sunIcon = document.getElementById("theme-icon-sun");
  const moonIcon = document.getElementById("theme-icon-moon");
  if (sunIcon !== null && moonIcon !== null) {
    // In dark mode show moon (click to go light), in light mode show sun (click to go dark)
    sunIcon.style.display = theme === "light" ? "block" : "none";
    moonIcon.style.display = theme === "dark" ? "block" : "none";
  }
  // Notify render.ts to re-resolve scheme-specific theme-color
  window.dispatchEvent(new Event("dotli:theme-changed"));
}

function initThemeToggle(): void {
  applyTheme(getStoredTheme());

  const btn = document.getElementById("theme-toggle");
  if (btn === null) {
    return;
  }
  btn.addEventListener("click", () => {
    const next = getStoredTheme() === "dark" ? "light" : "dark";
    localStorage.setItem("dotli-theme", next);
    applyTheme(next);
  });
}

// ── Init ───────────────────────────────────────────────────

export function initTopBar(): void {
  authButton = getElement("auth-button");
  modalBackdrop = getElement("auth-modal-backdrop");
  modalQr = getElement("auth-modal-qr");
  modalClose = getElement("auth-modal-close");
  userPopover = getElement("user-popover");
  userPopoverUsername = getElement("user-popover-username");
  userPopoverDisconnect = getElement("user-popover-disconnect");

  // Auth button: opens modal (logged out) or popover (logged in)
  authButton.addEventListener("click", handleAuthButtonClick);

  // Modal close button
  modalClose.addEventListener("click", closeModal);

  // Clicking backdrop (outside modal) closes modal
  modalBackdrop.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      closeModal();
    }
  });

  // Disconnect button
  userPopoverDisconnect.addEventListener("click", handleDisconnect);

  // Close popover when clicking outside
  document.addEventListener("click", (e) => {
    if (
      userPopover.classList.contains("open") &&
      !userPopover.contains(e.target as Node) &&
      !authButton.contains(e.target as Node)
    ) {
      userPopover.classList.remove("open");
    }
  });

  // Set logo home link from VITE_APP_URL (defaults to /)
  const homeLink = document.getElementById(
    "topbar-home",
  ) as HTMLAnchorElement | null;
  if (homeLink !== null) {
    homeLink.href = (import.meta.env.VITE_APP_URL as string | undefined) ?? "/";
  }

  // Theme toggle
  initThemeToggle();

  // Show default logged-out state
  renderLoggedOut();

  // If there's a persisted session, lazy-load auth to restore it.
  // Deferred to idle to avoid competing with critical-path bandwidth.
  // The storage adapter prefixes keys with "PAPP_<siteId>_", so check
  // for any key with that prefix to detect a persisted session.
  const hasPersistedSession = Object.keys(localStorage).some(
    (k) =>
      k.startsWith("PAPP_dot.li_") ||
      k.startsWith("PAPP_paseo.li_") ||
      k.startsWith("PAPP_local.li_"),
  );
  if (hasPersistedSession) {
    requestIdleCallback(() => {
      void ensureAuth();
    });
  }
}

// ── Render ─────────────────────────────────────────────────

function renderAuthState(state: AuthState): void {
  switch (state.status) {
    case "idle":
      renderLoggedOut();
      break;
    case "pairing":
      renderPairing(state.payload);
      break;
    case "attesting":
      renderAttesting();
      break;
    case "authenticated":
      renderLoggedIn(state);
      closeModal();
      break;
    case "error":
      renderError(state.message);
      break;
  }
}

function renderLoggedOut(): void {
  authButton.innerHTML = HEXAGON_SVG;
  authButton.title = "Login with Polkadot Mobile";
  window.dispatchEvent(new Event("dotli:logged-out"));
}

function renderLoggedIn(state: AuthState & { status: "authenticated" }): void {
  const initials =
    state.identity && authMod ? authMod.shortenName(state.identity) : "??";
  authButton.innerHTML = `<div class="user-badge">${initials}</div>`;
  authButton.title = "Account";
  window.dispatchEvent(new Event("dotli:authenticated"));

  // Update popover with identity name or truncated account address
  let username: string;
  const fullName = state.identity?.fullUsername;
  const liteName = state.identity?.liteUsername;
  if (
    (fullName !== undefined && fullName !== "") ||
    (liteName !== undefined && liteName !== "")
  ) {
    username = fullName ?? liteName ?? "";
  } else {
    // Fallback to truncated account address
    const id = Array.from(state.session.remoteAccount.accountId)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    username = `0x${id.slice(0, 6)}...${id.slice(-4)}`;
  }
  userPopoverUsername.textContent = username;
}

function renderPairing(payload: string): void {
  currentQrPayload = payload;

  if (!payload) {
    // Initial state — show spinner
    modalQr.innerHTML = `<div class="spinner"></div>`;
    return;
  }

  // Render QR code (lazy-load qrcode lib, guard against stale appends)
  const canvas = document.createElement("canvas");
  const capturedPayload = payload;
  void import("qrcode")
    .then((QRCode) =>
      QRCode.default.toCanvas(canvas, payload, {
        width: 200,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      }),
    )
    .then(() => {
      // Only append if this payload is still current
      if (currentQrPayload !== capturedPayload) {
        return;
      }
      modalQr.innerHTML = "";
      modalQr.appendChild(canvas);
    })
    .catch((err: unknown) => {
      console.error("[dot.li] QR render failed:", err);
    });
}

function renderAttesting(): void {
  modalQr.innerHTML = `
    <div class="attesting">
      <div class="spinner"></div>
      <p>Logging in...</p>
    </div>
  `;
}

function renderError(message: string): void {
  const container = document.createElement("div");
  container.style.textAlign = "center";

  const msg = document.createElement("p");
  msg.className = "auth-modal-error";
  msg.textContent = message;
  container.appendChild(msg);

  const retry = document.createElement("button");
  retry.className = "auth-modal-retry";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => {
    authMod?.startPairing();
  });
  container.appendChild(retry);

  modalQr.innerHTML = "";
  modalQr.appendChild(container);
}

// ── Handlers ───────────────────────────────────────────────

function handleAuthButtonClick(): void {
  if (authMod) {
    const state = authMod.getAuthState();

    if (state.status === "authenticated") {
      // Toggle user popover
      userPopover.classList.toggle("open");
    } else if (state.status === "attesting") {
      // Attestation still running in background — just reshow the modal
      modalBackdrop.classList.add("open");
    } else {
      // Open modal and start pairing
      openModal();
      authMod.startPairing();
    }
  } else {
    // Auth not loaded yet — load it and start pairing
    openModal();
    void ensureAuth().then(() => {
      authMod?.startPairing();
    });
  }
}

function handleDisconnect(): void {
  userPopover.classList.remove("open");
  if (authMod) {
    void authMod.disconnect();
  }
}

function openModal(): void {
  modalQr.innerHTML = `<div class="spinner"></div>`;
  modalBackdrop.classList.add("open");
}

function closeModal(): void {
  modalBackdrop.classList.remove("open");

  if (authMod) {
    const state = authMod.getAuthState();
    // Only abort during pairing or error — let attestation continue in background
    if (state.status === "pairing" || state.status === "error") {
      authMod.abortPairing();
    }
  }
}
