// dot.li — Authentication via Polkadot App (host-papp)
//
// Wraps @novasamatech/host-papp for QR-code-based pairing with the Polkadot App.
// Provides a simple pub-sub interface for the top bar UI.

import {
  SS_STABLE_STAGE_ENDPOINTS,
  createPappAdapter,
  type PappAdapter,
  type PairingStatus,
  type AttestationStatus,
  type Identity,
  type UserSession,
} from "@novasamatech/host-papp";
import { createLocalStorageAdapter } from "@novasamatech/storage-adapter";
import { createLazyClient } from "@novasamatech/statement-store";
import { getWsProvider } from "polkadot-api/ws-provider";

// ── Auth State ─────────────────────────────────────────────

export type AuthState =
  | { status: "idle" }
  | { status: "pairing"; payload: string }
  | { status: "attesting"; username?: string }
  | { status: "authenticated"; session: UserSession; identity: Identity | null }
  | { status: "error"; message: string };

type AuthListener = (state: AuthState) => void;

let adapter: PappAdapter | null = null;
let currentState: AuthState = { status: "idle" };
const listeners: Set<AuthListener> = new Set();

function setState(state: AuthState): void {
  console.log("[dot.li auth]", state.status, state);
  currentState = state;
  for (const fn of listeners) fn(state);
}

export function getAuthState(): AuthState {
  return currentState;
}

export function onAuthStateChange(fn: AuthListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── Initialization ─────────────────────────────────────────

export function initAuth(): void {
  const storage = createLocalStorageAdapter("dot.li");
  const lazyClient = createLazyClient(
    getWsProvider([...SS_STABLE_STAGE_ENDPOINTS]),
  );

  adapter = createPappAdapter({
    appId: "dot.li",
    metadata: "https://dot.li/host-metadata.json",
    adapters: { lazyClient, storage },
  });

  // Check for existing session
  const sessions = adapter.sessions.sessions.read();
  if (sessions.length > 0) {
    resolveIdentityAndSetAuth(sessions[0]!);
  }

  // Subscribe to session changes (handles reconnects)
  adapter.sessions.sessions.subscribe((sessions: UserSession[]) => {
    console.log(
      "[dot.li auth] sessions subscription fired, count:",
      sessions.length,
    );
    if (sessions.length > 0 && currentState.status !== "authenticated") {
      resolveIdentityAndSetAuth(sessions[0]!);
    } else if (
      sessions.length === 0 &&
      currentState.status === "authenticated"
    ) {
      setState({ status: "idle" });
    }
  });
}

async function resolveIdentityAndSetAuth(session: UserSession): Promise<void> {
  if (!adapter) return;

  // Set authenticated immediately with null identity, then resolve identity in background
  setState({ status: "authenticated", session, identity: null });

  try {
    const accountId = Array.from(session.remoteAccount.accountId)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const result = await adapter.identity.getIdentity(`0x${accountId}`);

    if (result.isOk() && result.value) {
      setState({ status: "authenticated", session, identity: result.value });
    }
  } catch (err) {
    console.warn("[dot.li] Failed to resolve identity:", err);
  }
}

/**
 * Pick up the first available session from the adapter.
 * Used as a fallback after pairing/attestation finishes.
 */
function pickUpSession(): void {
  if (!adapter) return;
  if (currentState.status === "authenticated") return;

  const sessions = adapter.sessions.sessions.read();
  if (sessions.length > 0) {
    resolveIdentityAndSetAuth(sessions[0]!);
  }
}

// ── Pairing Flow ───────────────────────────────────────────

let unsubPairing: (() => void) | null = null;
let unsubAttestation: (() => void) | null = null;

export function startPairing(): void {
  if (!adapter) return;

  // Show spinner immediately (don't wait for subscription callback)
  setState({ status: "pairing", payload: "" });

  // Clean up previous subscriptions (without aborting the adapter)
  unsubPairing?.();
  unsubAttestation?.();
  unsubPairing = null;
  unsubAttestation = null;

  unsubPairing = adapter.sso.pairingStatus.subscribe(
    (status: PairingStatus) => {
      console.log("[dot.li auth] pairingStatus:", status.step, status);
      switch (status.step) {
        case "initial":
          setState({ status: "pairing", payload: "" });
          break;
        case "pairing":
          setState({ status: "pairing", payload: status.payload });
          break;
        case "pairingError":
          setState({ status: "error", message: status.message });
          break;
        case "finished":
          // Pairing handshake done — attestation runs in parallel.
          // Transition to "attesting" so it shows a spinner and
          // the modal can't be dismissed (which would abort attestation).
          if (currentState.status !== "authenticated") {
            setState({ status: "attesting" });
          }
          break;
      }
    },
  );

  unsubAttestation = adapter.sso.attestationStatus.subscribe(
    (status: AttestationStatus) => {
      console.log("[dot.li auth] attestationStatus:", status.step, status);
      switch (status.step) {
        case "attestation":
          setState({ status: "attesting", username: status.username });
          break;
        case "attestationError":
          setState({ status: "error", message: status.message });
          break;
        case "finished":
          // Attestation done — session should now be saved.
          // The sessions.subscribe() callback is the primary pickup path,
          // but call pickUpSession() as a fallback.
          pickUpSession();
          break;
      }
    },
  );

  adapter.sso.authenticate().then(
    (result) => {
      console.log("[dot.li auth] authenticate() resolved:", result);
      if (result.isOk() && result.value) {
        // authenticate() resolved successfully — session is now persisted.
        // Pick up via sessions subscription or fallback here.
        pickUpSession();
      } else if (result.isErr()) {
        console.error("[dot.li auth] authenticate() error:", result.error);
        // Only show error if we're still in an active auth flow (not idle/authenticated)
        if (
          currentState.status !== "authenticated" &&
          currentState.status !== "idle"
        ) {
          setState({ status: "error", message: result.error.message });
        }
      }
    },
    (err) => {
      console.error("[dot.li auth] authenticate() rejected:", err);
    },
  );
}

export function abortPairing(): void {
  // Unsubscribe first to prevent status callbacks from firing during abort
  unsubPairing?.();
  unsubAttestation?.();
  unsubPairing = null;
  unsubAttestation = null;

  if (adapter) adapter.sso.abortAuthentication();

  // Reset to idle so the UI is clean
  if (currentState.status !== "authenticated") {
    setState({ status: "idle" });
  }
}

export async function disconnect(): Promise<void> {
  if (!adapter) return;
  if (currentState.status !== "authenticated") return;

  const session = currentState.session;
  await adapter.sessions.disconnect(session);
  setState({ status: "idle" });
}

// ── Helpers ────────────────────────────────────────────────

export function shortenName(identity: Identity): string {
  if (identity.fullUsername) {
    const parts = identity.fullUsername.split(" ");
    if (parts.length === 1) {
      return identity.fullUsername.slice(0, 2);
    }
    return parts[0]!.charAt(0) + parts[1]!.charAt(0);
  }
  return identity.liteUsername.slice(0, 2);
}
