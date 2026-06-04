// dot.li — Authentication via Polkadot App (host-papp)
//
// Wraps @novasamatech/host-papp for QR-code-based pairing with the Polkadot App.
// Provides a simple pub-sub interface for the top bar UI.

import {
  createPappAdapter,
  type PappAdapter,
  type PairingStatus,
  type Identity,
  type UserSession,
} from "@novasamatech/host-papp";
import { createSharedAuthStorageAdapter } from "./shared-storage";
import {
  createLazyClient,
  createPapiStatementStoreAdapter,
  type StatementStoreAdapter,
} from "@novasamatech/statement-store";
import type { Statement } from "@novasamatech/sdk-statement";
import { toHex } from "@novasamatech/host-api";
import { getWsProvider } from "polkadot-api/ws";
import { createRemoteChainProvider } from "@dotli/protocol/client";
import { ok, ResultAsync, type Result } from "neverthrow";
import { SITE_ID } from "@dotli/config/config";
import { getActiveServicesConfig } from "@dotli/config/network";
import { getBackend } from "@dotli/config/mode";
import { log } from "@dotli/shared/log";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";

declare const __DOTLI_VERSION__: string | undefined;

export type AuthState =
  | { status: "idle" }
  | { status: "pairing"; payload: string }
  | { status: "attesting" }
  | { status: "authenticated"; session: UserSession; identity: Identity | null }
  | { status: "error"; message: string };

type AuthListener = (state: AuthState) => void;

let adapter: PappAdapter | null = null;
let statementStoreInstance: StatementStoreAdapter | null = null;
let storeReadyResolvers: ((store: StatementStoreAdapter) => void)[] = [];
let currentState: AuthState = { status: "idle" };
const listeners = new Set<AuthListener>();

function setState(state: AuthState): void {
  log.warn("[dot.li auth]", state.status, state);
  currentState = state;
  for (const fn of listeners) {
    fn(state);
  }
}

export function getAuthState(): AuthState {
  return currentState;
}

export function onAuthStateChange(fn: AuthListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getStatementStore(): StatementStoreAdapter | null {
  return statementStoreInstance;
}

export function onStatementStoreReady(): Promise<StatementStoreAdapter> {
  if (statementStoreInstance) {
    return Promise.resolve(statementStoreInstance);
  }
  return new Promise((resolve) => {
    storeReadyResolvers.push(resolve);
  });
}

export async function readSessionSecret(
  sessionId: string,
): Promise<Uint8Array | null> {
  if (!adapter) {
    return null;
  }
  const result = await adapter.secrets.read(sessionId);
  if (result.isErr() || !result.value) {
    return null;
  }
  return result.value.ssSecret;
}

let initialized = false;

function toHexSafe(value: unknown): string {
  if (value instanceof Uint8Array) {
    return toHex(value);
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

function logStatement(prefix: string, stmt: Statement): void {
  const keys = Object.keys(stmt);
  log.warn(`${prefix} keys:`, keys);
  if (stmt.channel !== undefined) {
    log.warn(`${prefix} channel:`, stmt.channel);
  }
  if (stmt.topics !== undefined) {
    log.warn(`${prefix} topics:`, stmt.topics);
  }
  if (stmt.data !== undefined) {
    log.warn(
      `${prefix} data (${String(stmt.data.length)} bytes):`,
      toHexSafe(stmt.data),
    );
  }
}

function createLoggingStatementStore(
  inner: StatementStoreAdapter,
  queryTimeoutMs: number,
): StatementStoreAdapter {
  return {
    queryStatements(filter) {
      // sdk-statement's getStatements implements "query" as subscribe + wait
      // for an event with `data.remaining === 0`. Smoldot only emits the
      // statement_statement notification when fresh statements arrive via
      // gossip, never as an empty-initial-page sentinel, so for a topic
      // with no statements the query hangs forever — which leaves
      // session.init() stuck in 'initialization' and silently queues every
      // subsequent submitRequestMessage. Race against a short timeout
      // resolving to [] so init can proceed; the parallel subscribe still
      // delivers new statements normally.
      const inner$: Promise<Result<Statement[], Error>> = Promise.resolve(
        inner.queryStatements(filter),
      );
      const timeout$ = new Promise<Result<Statement[], Error>>((resolve) => {
        setTimeout(() => {
          resolve(ok([]));
        }, queryTimeoutMs);
      });
      return new ResultAsync<Statement[], Error>(
        Promise.race([inner$, timeout$]),
      );
    },
    subscribeStatements(filter, callback) {
      const topics = "matchAll" in filter ? filter.matchAll : filter.matchAny;
      log.warn(
        "[dotli ss] subscribeStatements called, topics count:",
        topics.length,
      );
      for (let i = 0; i < topics.length; i++) {
        log.warn(
          `[dotli ss]   topic[${String(i)}] (${String(topics[i].length)} bytes):`,
          toHexSafe(topics[i]),
        );
      }
      return inner.subscribeStatements(filter, (page) => {
        log.warn(
          "[dotli ss] >>> RECEIVED",
          page.statements.length,
          "statements (isComplete:",
          page.isComplete,
          ")",
        );
        for (let i = 0; i < page.statements.length; i++) {
          logStatement(`[dotli ss]   stmt[${String(i)}]`, page.statements[i]);
        }
        return callback(page);
      });
    },
    submitStatement(statement) {
      log.warn("[dotli ss] submitStatement called");
      logStatement("[dotli ss]  ", statement);
      const result = inner.submitStatement(statement);
      result.map(() => {
        log.warn("[dotli ss] submitStatement OK");
      });
      result.mapErr((e: Error) => {
        if (e.message.toLowerCase().includes("expiry too low")) {
          log.warn(
            "[dotli ss] submitStatement ExpiryTooLow (non-critical):",
            e.message,
          );
        } else {
          log.error("[dotli ss] submitStatement ERROR:", e);
        }
      });
      return result;
    },
  };
}

export function initAuth(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  const siteId = SITE_ID;
  const storage = createSharedAuthStorageAdapter(siteId);
  // Statement-store transport tracks the main Backend. smoldot variants
  // route through the protocol bridge; `rpc-gateway` uses the WS provider
  // directly.
  const useSmoldotForAuth = getBackend() !== "rpc-gateway";
  // Auth people chain endpoint resolved against the active network's services
  // config. The smoldot path routes through the protocol bridge by genesis;
  // the WS path dials the first RPC endpoint configured for the active people chain.
  const people = getActiveServicesConfig().people;
  let peopleProvider;
  let peopleRpcEndpoint: string | null = null;
  if (useSmoldotForAuth) {
    const remote = createRemoteChainProvider(people.genesis);
    if (remote === null) {
      throw new Error(
        "[dot.li auth] Protocol bridge does not support People Paseo chain",
      );
    }
    peopleProvider = remote;
  } else {
    if (people.rpcs.length === 0) {
      throw new Error(
        "[dot.li auth] Active network has no public People RPC endpoint",
      );
    }
    peopleRpcEndpoint = people.rpcs[0];
    peopleProvider = getWsProvider([peopleRpcEndpoint], {
      heartbeatTimeout: 120_000, // 2 minutes — default 40s is too aggressive through tunnels
    });
  }
  const lazyClient = createLazyClient(peopleProvider);
  if (peopleRpcEndpoint !== null) {
    m.setDefaults({ people_rpc_endpoint: peopleRpcEndpoint });
  }

  // Short timeout for the smoldot path covers its empty-topic hang. WS is a
  // generous upper bound that should never trip in practice.
  const queryStatementsTimeoutMs = useSmoldotForAuth ? 3_000 : 30_000;
  const rawStatementStore = createPapiStatementStoreAdapter(lazyClient);
  const statementStore = createLoggingStatementStore(
    rawStatementStore,
    queryStatementsTimeoutMs,
  );
  statementStoreInstance = statementStore;
  for (const resolve of storeReadyResolvers) {
    resolve(statementStore);
  }
  storeReadyResolvers = [];

  adapter = createPappAdapter({
    appId: siteId,
    hostMetadata: {
      hostName: "Polkadot Web",
      hostIcon: "https://dot.li/dotli.png",
      hostVersion:
        typeof __DOTLI_VERSION__ === "string" ? __DOTLI_VERSION__ : undefined,
    },
    adapters: { lazyClient, statementStore, storage },
  });

  // Check for the existing session
  const stopRestore = m.timer(S.AUTH_SESSION_RESTORE);
  const sessions = adapter.sessions.sessions.read();
  if (sessions.length > 0) {
    void resolveIdentityAndSetAuth(sessions[0]);
  }
  stopRestore();
  m.breadcrumb("Auth module loaded");

  // Subscribe to session changes (handles reconnects)
  adapter.sessions.sessions.subscribe((sessions: UserSession[]) => {
    log.warn(
      "[dot.li auth] sessions subscription fired, count:",
      sessions.length,
    );
    if (sessions.length > 0 && currentState.status !== "authenticated") {
      void resolveIdentityAndSetAuth(sessions[0]);
    } else if (
      sessions.length === 0 &&
      currentState.status === "authenticated"
    ) {
      setState({ status: "idle" });
    }
  });
}

async function resolveIdentityAndSetAuth(session: UserSession): Promise<void> {
  if (!adapter) {
    return;
  }

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
    log.warn("[dot.li] Failed to resolve identity:", err);
  }
}

/**
 * Pick up the first available session from the adapter.
 * Used as a fallback after pairing/attestation finishes.
 */
function pickUpSession(): void {
  if (!adapter) {
    return;
  }
  if (currentState.status === "authenticated") {
    return;
  }

  const sessions = adapter.sessions.sessions.read();
  if (sessions.length > 0) {
    void resolveIdentityAndSetAuth(sessions[0]);
  }
}

let unsubPairing: (() => void) | null = null;

export function startPairing(): void {
  if (!adapter) {
    return;
  }

  // Show spinner immediately (don't wait for subscription callback)
  setState({ status: "pairing", payload: "" });

  // Clean up previous subscription (without aborting the adapter)
  unsubPairing?.();
  unsubPairing = null;

  unsubPairing = adapter.sso.pairingStatus.subscribe(
    (status: PairingStatus) => {
      log.warn("[dot.li auth] pairingStatus:", status.step, status);
      switch (status.step) {
        case "initial":
          setState({ status: "pairing", payload: "" });
          break;
        case "pairing":
          setState({ status: "pairing", payload: status.payload });
          break;
        case "pending":
          // Setup work in progress (attestation etc.) — show spinner.
          if (currentState.status !== "authenticated") {
            setState({ status: "attesting" });
          }
          break;
        case "pairingError":
          setState({ status: "error", message: status.message });
          break;
        case "finished":
          // Pairing + attestation both done; session is persisted.
          // sessions.subscribe() is the primary pickup path, but call
          // pickUpSession() here as a fallback.
          if (currentState.status !== "authenticated") {
            setState({ status: "attesting" });
          }
          pickUpSession();
          break;
        case "none":
          break;
      }
    },
  );

  adapter.sso.authenticate().then(
    (result) => {
      log.warn("[dot.li auth] authenticate() resolved:", result);
      if (result.isOk() && result.value) {
        // authenticate() resolved successfully — session is now persisted.
        // Pick up via sessions subscription or fallback here.
        pickUpSession();
      } else if (result.isErr()) {
        log.error("[dot.li auth] authenticate() error:", result.error);
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
      log.error("[dot.li auth] authenticate() rejected:", err);
    },
  );
}

export function abortPairing(): void {
  // Unsubscribe first to prevent status callbacks from firing during abort
  unsubPairing?.();
  unsubPairing = null;

  if (adapter) {
    adapter.sso.abortAuthentication();
  }

  // Reset to idle so the UI is clean
  if (currentState.status !== "authenticated") {
    setState({ status: "idle" });
  }
}

export async function disconnect(): Promise<void> {
  if (!adapter) {
    return;
  }
  if (currentState.status !== "authenticated") {
    return;
  }

  const session = currentState.session;
  await adapter.sessions.disconnect(session);
  setState({ status: "idle" });
}

// Host-API wire codec (`LoginResult`) is `"success" | "alreadyConnected"
// | "rejected"` — keep this union aligned with it.
export type LoginFlowResult = "success" | "alreadyConnected" | "rejected";

/**
 * RFC-0009 bridge — products call this through `handleRequestLogin`
 * in the container. We dispatch a DOM event so the topbar (which
 * owns the QR pairing modal) can open the UI without this module
 * pulling in any DOM, and resolve once the auth state settles.
 */
export function requestLogin(
  reason: string | undefined,
  label?: string,
): Promise<LoginFlowResult> {
  if (currentState.status === "authenticated") {
    return Promise.resolve("alreadyConnected");
  }

  return new Promise((resolve) => {
    // Dispatch first so the topbar transitions us out of `idle` before
    // the subscription is installed — that way any post-subscribe
    // `idle` callback is unambiguously a user cancellation.
    window.dispatchEvent(
      new CustomEvent("dotli:request-login", { detail: { reason, label } }),
    );

    const unsubscribe = onAuthStateChange((state) => {
      if (state.status === "authenticated") {
        unsubscribe();
        resolve("success");
      } else if (state.status === "error" || state.status === "idle") {
        unsubscribe();
        resolve("rejected");
      }
    });
  });
}

// ── Helpers ────────────────────────────────────────────────

export function shortenName(identity: Identity): string {
  if (identity.fullUsername !== null && identity.fullUsername.length > 0) {
    const parts = identity.fullUsername.split(" ");
    if (parts.length === 1) {
      return identity.fullUsername.slice(0, 2);
    }
    return parts[0].charAt(0) + parts[1].charAt(0);
  }
  return identity.liteUsername.slice(0, 2);
}
