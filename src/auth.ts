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
  type StoredUserSession,
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
    metadata:
      "https://raw.githubusercontent.com/novasamatech/host-metadata/main/host-metadata.json",
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

function setAuthFromStoredSession(storedSession: StoredUserSession): void {
  if (!adapter) return;
  if (currentState.status === "authenticated") return;

  // First check if a full UserSession is already available in the session manager
  const sessions = adapter.sessions.sessions.read();
  const fullSession = sessions.find((s) => s.id === storedSession.id);

  if (fullSession) {
    resolveIdentityAndSetAuth(fullSession);
    return;
  }

  // The full session isn't in the manager yet (attestation still running).
  // Set authenticated with the stored session cast as UserSession for display.
  // The session manager subscription will update with the full session later.
  setState({
    status: "authenticated",
    session: storedSession as UserSession,
    identity: null,
  });
}

function checkForNewSession(): void {
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
          // Pairing done — the session is already available in the status.
          // Attestation (on-chain identity registration) may still be running
          // in the background, but we don't need to block login on it.
          console.log("[dot.li auth] pairing finished, using session directly");
          setAuthFromStoredSession(status.session);
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
          // Attestation done — try to pick up session immediately
          // (the sessions subscription should also fire, but as a fallback)
          checkForNewSession();
          break;
      }
    },
  );

  adapter.sso.authenticate().then(
    (result) => {
      console.log("[dot.li auth] authenticate() resolved:", result);
      if (result.isOk() && result.value) {
        console.log(
          "[dot.li auth] authenticate() success, session:",
          result.value,
        );
        checkForNewSession();
      } else if (result.isErr()) {
        console.error("[dot.li auth] authenticate() error:", result.error);
        if (currentState.status !== "authenticated") {
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
  if (adapter) adapter.sso.abortAuthentication();
  unsubPairing?.();
  unsubAttestation?.();
  unsubPairing = null;
  unsubAttestation = null;
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
