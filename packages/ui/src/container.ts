// dot.li — Host container bridge
//
// Bridges the host (dot.li) and the SPA loaded in the iframe using
// @novasamatech/host-container's postMessage-based protocol.
//
// Supports nested dApps: when a dApp embeds another dApp via iframe,
// the nested bridge detector dynamically creates additional bridges
// for each descendant dApp that sends protocol messages to window.top.

import {
  createDefaultLogger,
  RequestCredentialsErr,
  SigningErr,
  StorageErr,
} from "@novasamatech/host-api";
import type { Provider } from "@novasamatech/host-api";
import { createIframeProvider } from "@novasamatech/host-container";
import { createContainer } from "@novasamatech/host-container";
import type { Container } from "@novasamatech/host-container";
import { fromPromise } from "neverthrow";
import { isLocalhost } from "@dotli/config/config";

import type { UserSession } from "@novasamatech/host-papp";
import {
  getAuthState,
  onAuthStateChange,
  type AuthState,
} from "@dotli/auth/auth";
import { showSignPayloadModal, showSignRawModal } from "@dotli/auth/signing";
import { deriveProductPublicKey } from "@dotli/auth/account";
import {
  createRemoteChainProvider,
  isRemoteChainSupported,
} from "@dotli/protocol/client";
import { log } from "@dotli/shared/log";
import { showPushNotification } from "./notification";

// ── Session helpers (shared by all bridges) ────────────────

function getSession(): UserSession | null {
  const state = getAuthState();
  return state.status === "authenticated" ? state.session : null;
}

function subscribeSession(
  callback: (session: ReturnType<typeof getSession>) => void,
): () => void {
  callback(getSession());
  return onAuthStateChange((state: AuthState) => {
    callback(state.status === "authenticated" ? state.session : null);
  });
}

// ── Wire all container handlers ────────────────────────────

function wireContainerHandlers(
  container: Container,
  label: string,
  storagePrefix: string,
): void {
  // ── Feature support ────────────────────────────────────

  container.handleFeatureSupported((params, { ok }) => {
    switch (params.tag as string) {
      case "Chain":
        return ok(isRemoteChainSupported(params.value));
      default:
        return ok(false);
    }
  });

  // ── Chain connection ───────────────────────────────────

  container.handleChainConnection((genesisHash) => {
    return createRemoteChainProvider(genesisHash);
  });

  // ── Accounts ───────────────────────────────────────────

  container.handleAccountGet(
    ([dotNsIdentifier, derivationIndex], { ok, err }) => {
      const session = getSession();
      if (!session) {
        return err(new RequestCredentialsErr.NotConnected(undefined));
      }

      const publicKey = deriveProductPublicKey(
        session.remoteAccount.accountId,
        dotNsIdentifier,
        derivationIndex,
      );

      return ok({ publicKey, name: undefined });
    },
  );

  container.handleGetNonProductAccounts((_, { ok }) => {
    const state = getAuthState();
    if (state.status === "authenticated") {
      return ok([
        {
          publicKey: state.session.remoteAccount.accountId,
          name: state.identity?.liteUsername,
        },
      ]);
    }
    return ok([]);
  });

  container.handleAccountConnectionStatusSubscribe((_, send) => {
    return subscribeSession((session) => {
      send(session ? "connected" : "disconnected");
    });
  });

  // ── Signing ────────────────────────────────────────────

  container.handleSignPayload((payload, { ok, err }) => {
    log.warn(`[${label}] handleSignPayload invoked:`, {
      address: payload.address,
      genesisHash: payload.genesisHash,
      method: payload.method.slice(0, 40) + "...",
    });
    const session = getSession();
    if (!session) {
      log.error(`[${label}] handleSignPayload — no session, rejecting`);
      return err(new SigningErr.PermissionDenied(undefined));
    }

    return fromPromise(
      showSignPayloadModal(session, payload),
      (e) => e as never,
    )
      .andThen((result) => {
        log.warn(`[${label}] handleSignPayload — resolved OK`);
        return ok({
          signature: result.signature,
          signedTransaction: result.signedTransaction,
        });
      })
      .orElse((e) => {
        log.warn(`[${label}] handleSignPayload — rejected:`, e);
        return err(e);
      });
  });

  container.handleSignRaw((payload, { ok, err }) => {
    log.warn(`[${label}] handleSignRaw invoked:`, {
      address: payload.address,
      dataTag: payload.data.tag,
    });
    const session = getSession();
    if (!session) {
      log.error(`[${label}] handleSignRaw — no session, rejecting`);
      return err(new SigningErr.PermissionDenied(undefined));
    }

    return fromPromise(showSignRawModal(session, payload), (e) => e as never)
      .andThen((result) => {
        log.warn(`[${label}] handleSignRaw — resolved OK`);
        return ok({
          signature: result.signature,
          signedTransaction: result.signedTransaction,
        });
      })
      .orElse((e) => {
        log.warn(`[${label}] handleSignRaw — rejected:`, e);
        return err(e);
      });
  });

  // ── Local Storage (scoped per dApp) ────────────────────

  container.handleLocalStorageRead((key, { ok, err }) => {
    try {
      const raw = localStorage.getItem(storagePrefix + key);
      if (raw === null) {
        return ok(undefined);
      }
      const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
      return ok(bytes);
    } catch {
      return err(
        new StorageErr.Unknown({ reason: "Failed to read from storage" }),
      );
    }
  });

  container.handleLocalStorageWrite(([key, value], { ok, err }) => {
    try {
      const b64 = btoa(String.fromCharCode(...value));
      localStorage.setItem(storagePrefix + key, b64);
      return ok(undefined);
    } catch {
      return err(
        new StorageErr.Unknown({ reason: "Failed to write to storage" }),
      );
    }
  });

  container.handleLocalStorageClear((key, { ok, err }) => {
    try {
      localStorage.removeItem(storagePrefix + key);
      return ok(undefined);
    } catch {
      return err(new StorageErr.Unknown({ reason: "Failed to clear storage" }));
    }
  });

  // ── Navigation ─────────────────────────────────────────

  container.handleNavigateTo((url, { ok }) => {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      if (host.endsWith(".dot")) {
        const label = host.slice(0, -".dot".length);
        const target = isLocalhost
          ? `http://${label}.localhost:${window.location.port}${parsed.pathname}${parsed.search}${parsed.hash}`
          : `${window.location.protocol}//${label}.${window.location.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
        window.open(target, "_blank");
      } else {
        window.open(url, "_blank");
      }
    } catch {
      window.open(url, "_blank");
    }
    return ok(undefined);
  });

  // ── Permissions ────────────────────────────────────────

  container.handleDevicePermission((_permission, { ok }) => {
    return ok(false);
  });

  container.handlePermission((_request, { ok }) => {
    return ok(false);
  });

  // ── Push notifications ─────────────────────────────────

  container.handlePushNotification(({ text, deeplink }, { ok }) => {
    log.warn(`[${label}] Push notification:`, { text, deeplink });
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    showPushNotification({ text, deeplink, label });
    return ok(undefined);
  });
}

// ── Helpers ────────────────────────────────────────────────

/** Check if a value is a Uint8Array (or cross-realm equivalent). */
function isUint8ArrayLike(data: unknown): data is Uint8Array {
  if (data instanceof Uint8Array) {
    return true;
  }
  if (typeof data !== "object" || data === null) {
    return false;
  }
  return (
    (data as { constructor: { name: string } }).constructor.name ===
    "Uint8Array"
  );
}

// ── Window-based provider for nested dApps ─────────────────
//
// Implements the same Provider interface as createIframeProvider
// but targets a captured Window reference (from event.source)
// instead of an HTMLIFrameElement.

function createWindowProvider(sourceWindow: Window): Provider {
  let disposed = false;
  const subscribers = new Set<(message: Uint8Array) => void>();

  const messageHandler = (event: MessageEvent): void => {
    if (disposed) {
      return;
    }
    if (event.source !== sourceWindow) {
      return;
    }
    if (!isUint8ArrayLike(event.data)) {
      return;
    }

    for (const subscriber of subscribers) {
      subscriber(event.data);
    }
  };

  window.addEventListener("message", messageHandler);

  return {
    logger: createDefaultLogger(),

    isCorrectEnvironment() {
      return true;
    },
    postMessage(message) {
      if (disposed) {
        return;
      }
      sourceWindow.postMessage(message, "*", [message.buffer]);
    },
    subscribe(callback) {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
    dispose() {
      disposed = true;
      subscribers.clear();
      window.removeEventListener("message", messageHandler);
    },
  };
}

// ── Nested bridge detector ─────────────────────────────────
//
// Listens for Uint8Array postMessage events from windows other
// than the primary iframe. When a new source is detected, creates
// a full bridge (Provider + Container + handlers) for that window.
//
// This enables nested dApps (dApp-in-dApp) to communicate with
// the HOST, since all dApps send to window.top regardless of depth.

export function setupNestedBridgeDetector(
  primaryIframe: HTMLIFrameElement,
  label: string,
): () => void {
  const knownWindows = new Set<MessageEventSource>();
  const disposers: (() => void)[] = [];

  function messageHandler(event: MessageEvent): void {
    // Only handle protocol messages (Uint8Array)
    if (!isUint8ArrayLike(event.data)) {
      return;
    }
    // Skip messages from the primary iframe (handled by its own bridge)
    if (event.source === primaryIframe.contentWindow) {
      return;
    }
    // Skip messages from ourselves
    if (event.source === window) {
      return;
    }
    // Must have a source
    if (event.source === null) {
      return;
    }
    // Skip already-known nested windows
    if (knownWindows.has(event.source)) {
      return;
    }

    // New nested dApp detected
    knownWindows.add(event.source);
    const nestedId = String(knownWindows.size);
    log.warn(`[dot.li] Nested dApp #${nestedId} detected, creating bridge`);

    const provider = createWindowProvider(event.source as Window);
    const container = createContainer(provider);
    const nestedPrefix = `dotli:${label}:nested-${nestedId}:`;
    wireContainerHandlers(container, label, nestedPrefix);

    disposers.push(() => {
      container.dispose();
    });
  }

  window.addEventListener("message", messageHandler);

  return () => {
    window.removeEventListener("message", messageHandler);
    for (const dispose of disposers) {
      dispose();
    }
    knownWindows.clear();
    disposers.length = 0;
  };
}

// ── Main setup (primary bridge) ────────────────────────────

/**
 * Set up the host container for an iframe displaying a .dot SPA.
 *
 * Creates a postMessage-based provider, wires up all handlers
 * (accounts, signing, localStorage, etc.) and loads the URL in the iframe.
 *
 * Returns a dispose function to tear down the container.
 */
export function setupContainer(
  iframe: HTMLIFrameElement,
  blobUrl: string,
  label: string,
): () => void {
  const provider = createIframeProvider({ iframe, url: blobUrl });
  const container = createContainer(provider);
  const storagePrefix = `dotli:${label}:`;
  wireContainerHandlers(container, label, storagePrefix);

  return () => {
    container.dispose();
  };
}
