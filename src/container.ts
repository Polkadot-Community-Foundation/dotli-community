// dot.li — Host container bridge
//
// Bridges the host (dot.li) and the SPA loaded in the iframe using
// @novasamatech/host-container's postMessage-based protocol.

import {
  RequestCredentialsErr,
  SigningErr,
  StorageErr,
} from "@novasamatech/host-api";
import { createIframeProvider } from "@novasamatech/host-container";
import { createContainer } from "@novasamatech/host-container";
import { fromPromise } from "neverthrow";

import { getAuthState, onAuthStateChange, type AuthState } from "./auth";
import { showSignPayloadModal, showSignRawModal } from "./signing";
import { deriveProductPublicKey } from "./account";
import { createChainProvider, isChainSupported } from "./chains";

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

  // Helper: get the current session or null
  function getSession() {
    const state = getAuthState();
    return state.status === "authenticated" ? state.session : null;
  }

  // Helper: subscribe to session changes (for connection status)
  function subscribeSession(
    callback: (session: ReturnType<typeof getSession>) => void,
  ): () => void {
    // Send initial state
    callback(getSession());
    // Subscribe to future changes
    return onAuthStateChange((state: AuthState) => {
      callback(state.status === "authenticated" ? state.session : null);
    });
  }

  // ── Feature support ────────────────────────────────────

  container.handleFeatureSupported((params, { ok }) => {
    switch (params.tag) {
      case "Chain":
        return ok(isChainSupported(params.value));
      default:
        return ok(false);
    }
  });

  // ── Chain connection ───────────────────────────────────

  container.handleChainConnection((genesisHash) => {
    return createChainProvider(genesisHash);
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
    return subscribeSession((session) =>
      send(session ? "connected" : "disconnected"),
    );
  });

  // ── Signing ────────────────────────────────────────────

  container.handleSignPayload((payload, { ok, err }) => {
    const session = getSession();
    if (!session) {
      return err(new SigningErr.PermissionDenied(undefined));
    }

    return fromPromise(
      showSignPayloadModal(session, payload),
      (e) => e as never,
    )
      .andThen((result) =>
        ok({
          signature: result.signature,
          signedTransaction: result.signedTransaction,
        }),
      )
      .orElse((e) => err(e));
  });

  container.handleSignRaw((payload, { ok, err }) => {
    const session = getSession();
    if (!session) {
      return err(new SigningErr.PermissionDenied(undefined));
    }

    return fromPromise(showSignRawModal(session, payload), (e) => e as never)
      .andThen((result) =>
        ok({
          signature: result.signature,
          signedTransaction: result.signedTransaction,
        }),
      )
      .orElse((e) => err(e));
  });

  // ── Local Storage (scoped to domain) ───────────────────

  const storagePrefix = `dotli:${label}:`;

  container.handleLocalStorageRead((key, { ok, err }) => {
    try {
      const raw = localStorage.getItem(storagePrefix + key);
      if (raw === null) {
        return ok(undefined);
      }
      // Stored as base64-encoded bytes
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
      // Store as base64
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
    window.open(url, "_blank");
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

  container.handlePushNotification((text, { ok }) => {
    console.info(`[${label}] Notification:`, text);
    return ok(undefined);
  });

  // ── Dispose ────────────────────────────────────────────

  return () => {
    container.dispose();
  };
}
