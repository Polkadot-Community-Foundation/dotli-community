// dot.li — Top bar UI
//
// Manages the auth button, QR pairing modal, and user popover.
// All plain DOM manipulation — no framework.
//
// Auth module is lazy-loaded — the heavy host-papp, statement-store, and
// polkadot-api WS deps only load when a persisted session exists or the
// user clicks the auth button.

import type { AuthState } from "@dotli/auth/auth";
import type { Identity } from "@novasamatech/host-papp";
import { log } from "@dotli/shared/log";
import { escapeHtml } from "@dotli/shared/html";
import { SITE_ID } from "@dotli/config/config";
import {
  getMode,
  setMode,
  getCacheSettings,
  setCacheSettings,
  type DotliMode,
} from "@dotli/config/mode";
import {
  ALL_PERMISSIONS,
  getPermissionStatus,
  hasAnyGrant,
  isDevicePermission,
  resetPermission,
  setPermissionStatus,
} from "./permissions";

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

let modeButton: HTMLElement;
let modePopover: HTMLElement;
let modePopoverContent: HTMLElement;

let permissionsButton: HTMLElement;
let permissionsPopover: HTMLElement;
let permissionsPopoverList: HTMLElement;

/** The label of the currently loaded product (set via dotli:product-loaded event). */
let currentProductLabel: string | null = null;

// Hexagon SVG for the logged-out state
// User icon for the logged-out state
const USER_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

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
  shortenName: (identity: Identity) => string;
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
  authMod = (await import("@dotli/auth/auth")) as unknown as AuthModule;
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

  // Close popovers when clicking outside
  document.addEventListener("click", (e) => {
    if (
      userPopover.classList.contains("open") &&
      !userPopover.contains(e.target as Node) &&
      !authButton.contains(e.target as Node)
    ) {
      userPopover.classList.remove("open");
    }
    if (
      modePopover.classList.contains("open") &&
      !modePopover.contains(e.target as Node) &&
      !modeButton.contains(e.target as Node)
    ) {
      modePopover.classList.remove("open");
    }
    if (
      permissionsPopover.classList.contains("open") &&
      !permissionsPopover.contains(e.target as Node) &&
      !permissionsButton.contains(e.target as Node)
    ) {
      permissionsPopover.classList.remove("open");
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

  // Mode toggle (P2P / Centralized)
  initModeToggle();

  // Permissions
  initPermissions();

  // Show default logged-out state
  renderLoggedOut();

  // Probe the shared auth storage on host.dot.li. Sessions now live on the
  // shared host origin so sibling host shells can rehydrate after a
  // cross-subdomain navigation without eagerly loading the auth bundle for
  // every visitor.
  requestIdleCallback(() => {
    void (async () => {
      try {
        const { hasSharedAuthSession } = await import("@dotli/protocol/client");
        if (await hasSharedAuthSession(SITE_ID)) {
          await ensureAuth();
        }
      } catch (error) {
        log.warn("[dot.li auth] Shared session probe failed:", error);
      }
    })();
  });
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
  authButton.innerHTML = USER_SVG;
  authButton.title = "Login with Polkadot Mobile";
  window.dispatchEvent(new Event("dotli:logged-out"));
}

function renderLoggedIn(state: AuthState & { status: "authenticated" }): void {
  const initials =
    state.identity && authMod ? authMod.shortenName(state.identity) : "??";
  authButton.innerHTML = `<div class="user-badge">${escapeHtml(initials)}</div>`;
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
      log.error("[dot.li] QR render failed:", err);
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

// ── Permissions ───────────────────────────────────────────

const PERM_ICONS: Record<string, string> = {
  Camera:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  Microphone:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
  Location:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  Bluetooth:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/></svg>',
  TransactionSubmit:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
};

function initPermissions(): void {
  permissionsButton = getElement("permissions-button");
  permissionsPopover = getElement("permissions-popover");
  permissionsPopoverList = getElement("permissions-popover-list");

  permissionsButton.addEventListener("click", () => {
    permissionsPopover.classList.toggle("open");
    if (permissionsPopover.classList.contains("open")) {
      renderPermissionsPopover();
    }
  });

  // Update when a product is loaded
  window.addEventListener("dotli:product-loaded", (e) => {
    const { label } = (e as CustomEvent<{ label: string }>).detail;
    currentProductLabel = label;
    updatePermissionsButtonState();
    if (permissionsPopover.classList.contains("open")) {
      renderPermissionsPopover();
    }
  });

  // Update after permission changes
  window.addEventListener("dotli:device-permission-changed", () => {
    updatePermissionsButtonState();
    if (permissionsPopover.classList.contains("open")) {
      renderPermissionsPopover();
    }
  });

  window.addEventListener("dotli:permission-changed", () => {
    updatePermissionsButtonState();
    if (permissionsPopover.classList.contains("open")) {
      renderPermissionsPopover();
    }
  });
}

/** Update the shield icon to reflect whether any permissions are active. */
function updatePermissionsButtonState(): void {
  if (currentProductLabel === null) {
    return;
  }
  permissionsButton.classList.toggle(
    "has-grants",
    hasAnyGrant(currentProductLabel),
  );
}

function renderPermissionsPopover(): void {
  permissionsPopoverList.innerHTML = "";

  if (currentProductLabel === null) {
    const hint = document.createElement("div");
    hint.className = "permissions-popover-footer";
    hint.textContent =
      "Wait for the app to finish loading to change its permissions.";
    permissionsPopoverList.appendChild(hint);
    return;
  }

  for (const perm of ALL_PERMISSIONS) {
    const status = getPermissionStatus(currentProductLabel, perm.name);

    const row = document.createElement("div");
    row.className = "permissions-popover-row";

    const icon = document.createElement("span");
    icon.className = "permissions-popover-icon";
    icon.innerHTML = PERM_ICONS[perm.name] ?? "";
    row.appendChild(icon);

    const nameEl = document.createElement("span");
    nameEl.className = "permissions-popover-name";
    nameEl.textContent = perm.label;
    row.appendChild(nameEl);

    // Toggle switch
    const toggle = document.createElement("button");
    toggle.className = `permissions-popover-toggle ${status === "granted" ? "on" : ""}`;
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(status === "granted"));
    toggle.title =
      status === "granted" ? "Revoke permission" : "Grant permission";

    const track = document.createElement("span");
    track.className = "permissions-toggle-track";
    const knob = document.createElement("span");
    knob.className = "permissions-toggle-knob";
    track.appendChild(knob);
    toggle.appendChild(track);

    toggle.addEventListener("click", () => {
      if (currentProductLabel === null) {
        return;
      }
      if (status === "granted") {
        resetPermission(currentProductLabel, perm.name);
      } else {
        setPermissionStatus(currentProductLabel, perm.name, "granted");
      }
      // Device permissions need iframe reload (allow attribute changes).
      // Non-device permissions just update the UI.
      const event = isDevicePermission(perm.name)
        ? "dotli:device-permission-changed"
        : "dotli:permission-changed";
      window.dispatchEvent(
        new CustomEvent(event, {
          detail: { label: currentProductLabel, permission: perm.name },
        }),
      );
      renderPermissionsPopover();
    });

    row.appendChild(toggle);
    permissionsPopoverList.appendChild(row);
  }

  // Footer notice
  const footer = document.createElement("div");
  footer.className = "permissions-popover-footer";
  footer.textContent = "Changing permissions will reload the app.";
  permissionsPopoverList.appendChild(footer);
}

// ── Resolution Mode Toggle ───────────────────────────────────

function initModeToggle(): void {
  modeButton = getElement("mode-button");
  modePopover = getElement("mode-popover");
  modePopoverContent = getElement("mode-popover-content");

  // Show gateway-mode indicator on the button
  modeButton.classList.toggle("gateway-mode", getMode() === "gateway");

  modeButton.addEventListener("click", () => {
    modePopover.classList.toggle("open");
    if (modePopover.classList.contains("open")) {
      renderModePopover();
    }
  });
}

function renderModeRadio(
  value: DotliMode,
  label: string,
  description: string,
  currentMode: DotliMode,
): void {
  const selected = value === currentMode;
  const row = document.createElement("label");
  row.className = `mode-radio-row${selected ? " selected" : ""}`;

  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "dotli-mode";
  radio.value = value;
  radio.checked = selected;
  radio.className = "mode-radio-input";
  row.appendChild(radio);

  const dot = document.createElement("span");
  dot.className = "mode-radio-dot";
  row.appendChild(dot);

  const text = document.createElement("span");
  text.className = "mode-radio-text";
  text.innerHTML = `<span class="mode-radio-label">${label}</span><span class="mode-radio-desc">${description}</span>`;
  row.appendChild(text);

  radio.addEventListener("change", () => {
    setMode(value);
    window.location.reload();
  });

  modePopoverContent.appendChild(row);
}

function renderModePopover(): void {
  const currentMode = getMode();
  const isP2p = currentMode !== "gateway";
  const cache = getCacheSettings(currentMode);

  modePopoverContent.innerHTML = "";

  // ── Section 1: P2P Light Client ──
  const p2pHeader = document.createElement("div");
  p2pHeader.className = "mode-popover-section";
  p2pHeader.textContent = "P2P Light Client";
  modePopoverContent.appendChild(p2pHeader);

  renderModeRadio(
    "p2p-shared-worker",
    "SharedWorker",
    "Shared across tabs (recommended)",
    currentMode,
  );
  renderModeRadio(
    "p2p-direct",
    "Direct (per-tab)",
    "Independent per tab",
    currentMode,
  );

  // ── Divider ──
  appendDivider();

  // ── Section 2: Gateway ──
  renderModeRadio(
    "gateway",
    "Gateway (fast)",
    "Fast loading from trusted nodes",
    currentMode,
  );

  // ── Section 3: P2P Cache (only visible for P2P modes) ──
  if (isP2p) {
    appendDivider();

    const cacheHeader = document.createElement("div");
    cacheHeader.className = "mode-popover-section";
    cacheHeader.textContent = "P2P Cache";
    modePopoverContent.appendChild(cacheHeader);

    renderCacheToggle("CID cache", !cache.skipCidCache, (enabled) => {
      setCacheSettings({ ...cache, skipCidCache: !enabled });
      window.location.reload();
    });

    renderCacheToggle("Content cache", !cache.skipArchiveCache, (enabled) => {
      setCacheSettings({ ...cache, skipArchiveCache: !enabled });
      window.location.reload();
    });

    // Clear chain data button
    const clearRow = document.createElement("div");
    clearRow.className = "mode-cache-row";
    const clearBtn = document.createElement("button");
    clearBtn.className = "mode-clear-btn";
    clearBtn.textContent = "Clear chain data";
    clearBtn.title =
      "Delete smoldot chain database and reload (forces cold sync)";
    clearBtn.addEventListener("click", () => {
      void clearSmoldotDatabases().then(() => {
        window.location.reload();
      });
    });
    clearRow.appendChild(clearBtn);
    modePopoverContent.appendChild(clearRow);
  }

  // ── Footer ──
  const footer = document.createElement("div");
  footer.className = "mode-popover-hint";
  footer.textContent = "Changing settings will reload the page.";
  modePopoverContent.appendChild(footer);
}

function appendDivider(): void {
  const divider = document.createElement("div");
  divider.className = "mode-popover-divider";
  modePopoverContent.appendChild(divider);
}

async function clearSmoldotDatabases(): Promise<void> {
  try {
    if (typeof indexedDB.databases === "function") {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (
          db.name !== undefined &&
          db.name !== "" &&
          db.name !== "dotli" &&
          db.name !== "dotli-sw"
        ) {
          indexedDB.deleteDatabase(db.name);
        }
      }
    }
    // Also clear our own chain store
    const { getDb } = await import("@dotli/storage/db");
    const db = await getDb();
    const tx = db.transaction("chains", "readwrite");
    tx.objectStore("chains").clear();
  } catch {
    // Best effort — some browsers restrict indexedDB.databases()
  }
}

function renderCacheToggle(
  label: string,
  checked: boolean,
  onChange: (enabled: boolean) => void,
): void {
  const row = document.createElement("div");
  row.className = "mode-cache-row";

  const nameEl = document.createElement("span");
  nameEl.className = "mode-cache-label";
  nameEl.textContent = label;
  row.appendChild(nameEl);

  const toggle = document.createElement("button");
  toggle.className = `permissions-popover-toggle ${checked ? "on" : ""}`;
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(checked));

  const track = document.createElement("span");
  track.className = "permissions-toggle-track";
  const knob = document.createElement("span");
  knob.className = "permissions-toggle-knob";
  track.appendChild(knob);
  toggle.appendChild(track);

  toggle.addEventListener("click", () => {
    onChange(!checked);
  });

  row.appendChild(toggle);
  modePopoverContent.appendChild(row);
}

// ── Modal ─────────────────────────────────────────────────

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
