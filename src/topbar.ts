// dot.li — Top bar UI
//
// Manages the auth button, QR pairing modal, and user popover.
// All plain DOM manipulation — no framework.

import QRCode from "qrcode";

import {
  type AuthState,
  getAuthState,
  onAuthStateChange,
  startPairing,
  abortPairing,
  disconnect,
  shortenName,
} from "./auth";

// ── DOM refs ───────────────────────────────────────────────

const authButton = document.getElementById("auth-button")!;
const modalBackdrop = document.getElementById("auth-modal-backdrop")!;
const modalQr = document.getElementById("auth-modal-qr")!;
const modalClose = document.getElementById("auth-modal-close")!;
const userPopover = document.getElementById("user-popover")!;
const userPopoverUsername = document.getElementById("user-popover-username")!;
const userPopoverDisconnect = document.getElementById(
  "user-popover-disconnect",
)!;

// Hexagon SVG for the logged-out state
const HEXAGON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`;

// ── Init ───────────────────────────────────────────────────

export function initTopBar(): void {
  // Auth button: opens modal (logged out) or popover (logged in)
  authButton.addEventListener("click", handleAuthButtonClick);

  // Modal close button
  modalClose.addEventListener("click", closeModal);

  // Clicking backdrop closes modal
  modalBackdrop.addEventListener("click", (e) => {
    if (e.target === modalBackdrop) closeModal();
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

  // Subscribe to auth state changes
  onAuthStateChange(renderAuthState);

  // Render initial state
  renderAuthState(getAuthState());
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
  authButton.title = "Login with Polkadot App";
}

function renderLoggedIn(state: AuthState & { status: "authenticated" }): void {
  const initials = state.identity ? shortenName(state.identity) : "??";
  authButton.innerHTML = `<div class="user-badge">${initials}</div>`;
  authButton.title = "Account";

  // Update popover
  const username =
    state.identity?.fullUsername ??
    state.identity?.liteUsername ??
    "Unknown user";
  userPopoverUsername.textContent = username;
}

function renderPairing(payload: string): void {
  if (!payload) {
    // Initial state — show spinner
    modalQr.innerHTML = `<div class="spinner"></div>`;
    return;
  }

  // Render QR code (toCanvas is async)
  const canvas = document.createElement("canvas");
  QRCode.toCanvas(canvas, payload, {
    width: 200,
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" },
  })
    .then(() => {
      modalQr.innerHTML = "";
      modalQr.appendChild(canvas);
    })
    .catch((err: unknown) => {
      console.error("[dot.li] QR render failed:", err);
    });
}

function renderAttesting(): void {
  modalQr.innerHTML = `
    <div style="text-align:center;">
      <div class="spinner"></div>
      <p style="color:#888;font-size:0.8rem;margin-top:8px;">Logging in...</p>
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
  retry.addEventListener("click", () => startPairing());
  container.appendChild(retry);

  modalQr.innerHTML = "";
  modalQr.appendChild(container);
}

// ── Handlers ───────────────────────────────────────────────

function handleAuthButtonClick(): void {
  const state = getAuthState();

  if (state.status === "authenticated") {
    // Toggle user popover
    userPopover.classList.toggle("open");
  } else {
    // Open modal and start pairing
    openModal();
    startPairing();
  }
}

function handleDisconnect(): void {
  userPopover.classList.remove("open");
  disconnect();
}

function openModal(): void {
  modalQr.innerHTML = `<div class="spinner"></div>`;
  modalBackdrop.classList.add("open");
}

function closeModal(): void {
  modalBackdrop.classList.remove("open");
  const state = getAuthState();
  if (state.status === "pairing" || state.status === "attesting") {
    abortPairing();
  }
}
