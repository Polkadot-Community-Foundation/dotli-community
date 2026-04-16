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
  GenericError,
  PreimageSubmitErr,
  RequestCredentialsErr,
  SigningErr,
  StatementProofErr,
  StorageErr,
} from "@novasamatech/host-api";
import type { Provider } from "@novasamatech/host-api";
import { createIframeProvider } from "@novasamatech/host-container";
import { createContainer } from "@novasamatech/host-container";
import type { Container } from "@novasamatech/host-container";
import type { SignedStatement } from "@novasamatech/sdk-statement";
import {
  createSr25519Prover,
  type StatementStoreAdapter,
} from "@novasamatech/statement-store";
import { errAsync, fromPromise, okAsync } from "neverthrow";
import { isLocalhost, BASE_DOMAIN } from "@dotli/config/config";
import { getPermissionStatus, setPermissionStatus } from "./permissions";
import { showPermissionRequestModal } from "./permission-modal";

import type { UserSession } from "@novasamatech/host-papp";
import {
  getAuthState,
  getStatementStore,
  onAuthStateChange,
  onStatementStoreReady,
  readSessionSecret,
  type AuthState,
} from "@dotli/auth/auth";
import { showSignPayloadModal, showSignRawModal } from "@dotli/auth/signing";
import { deriveProductPublicKey } from "@dotli/auth/account";
import {
  createRemoteChainProvider,
  isRemoteChainSupported,
} from "@dotli/protocol/client";
import { MAX_NESTED_BRIDGES } from "@dotli/config/config";
import { dotNsUrl } from "@dotli/shared/dotns-url";
import { log } from "@dotli/shared/log";
import { getMode, isP2pMode } from "@dotli/config/mode";
import { concatBytes } from "@noble/hashes/utils.js";
import { computePreimageKey, hashToCid } from "@dotli/content/preimage";
import { ensureHelia } from "@dotli/content/fetch";
import { fetchFromIpfs } from "@dotli/content/ipfs";
import {
  ensureBulletinClient,
  submitPreimageTransaction,
  getTestSigner,
} from "@dotli/resolver/bulletin";
import { showPushNotification } from "./notification";
import { showNotification } from "./notification";
import { showAliasPermissionModal } from "./alias-permission-modal";
import { showPreimageSubmitModal } from "./preimage-modal";
import {
  mapFromHostSignedStatement,
  mapFromHostStatement,
  mapSdkProof,
  mapSdkSignedStatement,
} from "./statement-store-mapping";

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
  let chainConnectionWarned = false;

  function warnOnRawChainConnection(genesisHash: string): void {
    if (chainConnectionWarned) {
      return;
    }
    chainConnectionWarned = true;

    log.warn(
      `[${label}] Raw chain connection requested (genesis=${genesisHash.slice(0, 10)}…, storage=${storagePrefix})`,
    );

    showNotification({
      label: "Direct Chain Access",
      text: "This app uses a direct chain connection instead of the recommended host API.",
      dismissMs: 8000,
      browserNotification: false,
    });
  }

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
    warnOnRawChainConnection(genesisHash);
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

  const aliasLimiter = createSubmitRateLimiter();

  container.handleAccountGetAlias((productAccountId, { err }) => {
    if (!aliasLimiter.allow()) {
      return errAsync(
        new RequestCredentialsErr.Unknown({ reason: "Rate limited" }),
      );
    }

    const session = getSession();
    if (!session) {
      return err(new RequestCredentialsErr.NotConnected(undefined));
    }

    if (
      !Array.isArray(productAccountId) ||
      typeof productAccountId[0] !== "string" ||
      !productAccountId[0].endsWith(".dot")
    ) {
      return err(new RequestCredentialsErr.DomainNotValid(undefined));
    }

    const identifier = label + ".dot";
    const isOwnDomain = identifier === productAccountId[0];

    if (isOwnDomain) {
      return session
        .getRingVrfAlias(productAccountId, identifier)
        .mapErr(
          (error) =>
            new RequestCredentialsErr.Unknown({ reason: error.message }),
        );
    }

    return fromPromise(
      showAliasPermissionModal(identifier, productAccountId[0]),
      () => new RequestCredentialsErr.Rejected(undefined),
    ).andThen(() =>
      session
        .getRingVrfAlias(productAccountId, identifier)
        .mapErr(
          (error) =>
            new RequestCredentialsErr.Unknown({ reason: error.message }),
        ),
    );
  });

  // ── Signing ────────────────────────────────────────────

  container.handleSignPayload((payload, { ok, err }) => {
    log.warn(`[${label}] handleSignPayload invoked:`, {
      address: payload.address,
      genesisHash: payload.genesisHash,
      method: payload.method.slice(0, 40) + "...",
    });
    if (getPermissionStatus(label, "TransactionSubmit") !== "granted") {
      log.warn(`[${label}] handleSignPayload — TransactionSubmit not granted`);
      showNotification({
        label: `${label}.dot`,
        text: 'Transaction blocked — enable "Sign Transactions" in the permissions menu.',
        dismissMs: 6000,
        browserNotification: false,
      });
      return err(new SigningErr.PermissionDenied(undefined));
    }
    const session = getSession();
    if (!session) {
      log.error(`[${label}] handleSignPayload — no session, rejecting`);
      return err(new SigningErr.PermissionDenied(undefined));
    }

    return fromPromise(
      showSignPayloadModal(session, payload, label),
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

    return fromPromise(
      showSignRawModal(session, payload, label),
      (e) => e as never,
    )
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
    const dotUrl = dotNsUrl.parseDotNsDomain(url);

    if (dotUrl && dotNsUrl.isDotDomain(dotUrl.identifier)) {
      // .dot domain (including polkadot:// scheme)
      window.open(
        buildDotTargetUrl(
          identifierToLabel(dotUrl.identifier),
          dotUrl.pathname,
        ),
        "_blank",
      );
    } else {
      const localhostUrl = dotNsUrl.parseLocalhostUrl(url);
      if (localhostUrl) {
        // localhost product → wrap in host URL
        const suffix = localhostUrl.pathname ? "/" + localhostUrl.pathname : "";
        window.open(
          `${getHostOrigin()}/${localhostUrl.host}${suffix}`,
          "_blank",
        );
      } else {
        window.open(dotNsUrl.normalizeUrl(url), "_blank");
      }
    }

    return ok(undefined);
  });

  // ── Permissions ────────────────────────────────────────

  const permissionLimiter = createSubmitRateLimiter();

  container.handleDevicePermission((permission, { ok }) => {
    if (!permissionLimiter.allow()) {
      return okAsync(false);
    }

    const status = getPermissionStatus(label, permission);

    if (status === "granted") {
      return ok(true);
    }

    if (status === "denied") {
      showNotification({
        label: `${label}.dot`,
        text: `${permission} access is blocked. Use the permissions menu in the top bar to change this.`,
        dismissMs: 6000,
        browserNotification: false,
      });
      return ok(false);
    }

    // status === 'ask' — show consent modal
    return fromPromise(
      showPermissionRequestModal(label, permission).then(() => {
        setPermissionStatus(label, permission, "granted");
        // Defer the reload to the next event loop tick so the
        // container can finish sending the response before being
        // disposed. Without this, cleanup() runs synchronously
        // inside the dispatch, disposing the transport mid-response.
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("dotli:device-permission-changed", {
              detail: { label, permission },
            }),
          );
        }, 0);
      }),
      () => "denied" as const,
    )
      .map(() => {
        // User allowed — but iframe reloads, so return false for now
        return false;
      })
      .orElse(() => {
        // User denied (rejected promise) or dialog dismissed
        setPermissionStatus(label, permission, "denied");
        return ok(false);
      });
  });

  // remote_permission — only TransactionSubmit is enforced;
  // ExternalRequest has no enforcement mechanism in browser context.
  container.handlePermission((request, { ok }) => {
    if (request.tag !== "TransactionSubmit") {
      return ok(false);
    }

    if (!permissionLimiter.allow()) {
      return okAsync(false);
    }

    const status = getPermissionStatus(label, "TransactionSubmit");

    if (status === "granted") {
      return ok(true);
    }

    if (status === "denied") {
      showNotification({
        label: `${label}.dot`,
        text: "Transaction signing is blocked. Use the permissions menu in the top bar to change this.",
        dismissMs: 6000,
        browserNotification: false,
      });
      return ok(false);
    }

    // status === 'ask' — show consent modal
    return fromPromise(
      showPermissionRequestModal(label, "TransactionSubmit").then(() => {
        setPermissionStatus(label, "TransactionSubmit", "granted");
        // No iframe reload needed — signing handlers read permission at call time.
        // But dispatch event so topbar updates.
        window.dispatchEvent(
          new CustomEvent("dotli:permission-changed", {
            detail: { label },
          }),
        );
      }),
      () => "denied" as const,
    )
      .map(() => true)
      .orElse(() => {
        setPermissionStatus(label, "TransactionSubmit", "denied");
        return ok(false);
      });
  });

  // ── Push notifications ─────────────────────────────────

  container.handlePushNotification(({ text, deeplink }, { ok }) => {
    log.warn(`[${label}] Push notification:`, { text, deeplink });
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    showPushNotification({ text, deeplink, label });
    return ok(undefined);
  });

  // ── Statement Store ───────────────────────────────────
  //
  // Handlers resolve getStatementStore() lazily (at call time, not setup time)
  // because initAuth() is lazy-loaded and may not have run yet.

  const submitLimiter = createSubmitRateLimiter();

  container.handleStatementStoreSubscribe((topics, send) => {
    let innerUnsub: (() => void) | null = null;
    let cancelled = false;

    function startSubscription(store: StatementStoreAdapter): void {
      if (cancelled) {
        return;
      }
      log.warn(`[${label}] Statement store subscribe, topics:`, topics.length);
      innerUnsub = store.subscribeStatements(topics, (statements) => {
        log.warn(
          `[${label}] Statement store received ${String(statements.length)} statements`,
        );
        const signed = statements.filter(
          (s): s is SignedStatement => s.proof !== undefined,
        );
        if (signed.length > 0) {
          send(signed.map(mapSdkSignedStatement));
        }
      });
    }

    const store = getStatementStore();
    if (store) {
      startSubscription(store);
    } else {
      log.warn(
        `[${label}] Statement store subscribe — store not ready, waiting…`,
      );
      void onStatementStoreReady().then(startSubscription);
    }

    return () => {
      cancelled = true;
      innerUnsub?.();
    };
  });

  container.handleStatementStoreSubmit((statement) => {
    const store = getStatementStore();
    if (!store) {
      return errAsync(
        new GenericError({ reason: "Statement store not initialized" }),
      );
    }
    if (!submitLimiter.allow()) {
      return errAsync(new GenericError({ reason: "Rate limited" }));
    }
    return store
      .submitStatement(mapFromHostSignedStatement(statement))
      .map(() => undefined)
      .mapErr((e: Error) => new GenericError({ reason: e.message }));
  });

  // NOTE: ProductAccountId ([dotNsIdentifier, derivationIndex]) is intentionally
  // unused — the proof is always signed with the root session key because only
  // the session account has an on-chain allowance (quota) on People Chain.
  // Derived product accounts are not registered and cannot submit statements.
  container.handleStatementStoreCreateProof(([, statement], { err }) => {
    const session = getSession();
    if (!session) {
      return err(new StatementProofErr.UnableToSign());
    }

    return fromPromise(readSessionSecret(session.id), (e) =>
      e instanceof Error ? e : new Error(String(e)),
    )
      .mapErr((e) => new StatementProofErr.Unknown({ reason: e.message }))
      .andThen((secret) =>
        secret
          ? fromPromise(
              Promise.resolve(createSr25519Prover(secret)),
              () => new StatementProofErr.UnableToSign(),
            )
          : err(new StatementProofErr.UnableToSign()),
      )
      .andThen((prover) =>
        prover
          .generateMessageProof(mapFromHostStatement(statement))
          .mapErr((e) => new StatementProofErr.Unknown({ reason: e.message })),
      )
      .map((signed) => mapSdkProof(signed.proof));
  });

  // ── Preimage ──────────────────────────────────────────────
  //
  // Submit stores data on Bulletin Paseo via TransactionStorage.store()
  // using smoldot, returns the Blake2b-256 hash key.
  // Lookup retrieves data by hash via Helia P2P (IPFS gateway fallback).

  const preimageCache = new Map<string, Uint8Array>();
  const preimageLimiter = createSubmitRateLimiter();

  // Eagerly start Bulletin chain sync so it's ready by the time
  // a product calls remote_preimage_submit. Only in P2P mode —
  // gateway mode should not create any smoldot instances.
  if (isP2pMode(getMode())) {
    void ensureBulletinClient();
  }

  container.handlePreimageSubmit((value, { err }) => {
    log.warn(
      `[${label}] Preimage submit request, size: ${String(value.byteLength)}`,
    );

    if (!preimageLimiter.allow()) {
      return err(new PreimageSubmitErr.Unknown({ reason: "Rate limited" }));
    }

    return fromPromise(showPreimageSubmitModal(value.byteLength), (e) =>
      e instanceof Error ? e.message : "User denied preimage submit",
    )
      .andThen(() => {
        const key = computePreimageKey(value);
        return fromPromise(
          submitPreimageTransaction(value, getTestSigner()),
          (e) => (e instanceof Error ? e.message : String(e)),
        ).map(() => {
          preimageCache.set(key, value);
          log.warn(`[${label}] Preimage stored, key: ${key}`);
          return key;
        });
      })
      .mapErr((reason) => new PreimageSubmitErr.Unknown({ reason }));
  });

  container.handlePreimageLookupSubscribe((key, send, interrupt) => {
    log.warn(`[${label}] Preimage lookup subscribe, key: ${key}`);

    let stopped = false;
    let consecutiveFailures = 0;

    // Check local cache first
    const cached = preimageCache.get(key);
    if (cached) {
      send(cached);
    } else {
      send(null);
    }

    // Poll: Helia P2P first, IPFS gateway fallback
    const poll = async (): Promise<void> => {
      if (stopped) {
        return;
      }

      // Re-check cache (may have been populated by a submit)
      const cachedValue = preimageCache.get(key);
      if (cachedValue) {
        send(cachedValue);
        consecutiveFailures = 0;
        return;
      }

      const cid = hashToCid(key);
      const cidString = cid.toString();

      // Try Helia P2P
      try {
        const helia = await ensureHelia();
        const chunks: Uint8Array[] = [];
        const blockData = helia.blockstore.get(cid);
        if (blockData instanceof Uint8Array) {
          chunks.push(blockData);
        } else if (
          typeof blockData === "object" &&
          Symbol.asyncIterator in Object(blockData)
        ) {
          for await (const chunk of blockData as AsyncIterable<Uint8Array>) {
            chunks.push(chunk);
          }
        }
        if (chunks.length > 0) {
          const data = concatBytes(...chunks);
          if (data.length > 0) {
            preimageCache.set(key, data);
            send(data);
            consecutiveFailures = 0;
            return;
          }
        }
      } catch {
        // Helia failed, try gateway
      }

      // Fallback: IPFS gateway
      try {
        const result = await fetchFromIpfs(cidString);
        if (result.data.length > 0) {
          preimageCache.set(key, result.data);
          send(result.data);
          consecutiveFailures = 0;
          return;
        }
      } catch {
        // Both failed
      }

      consecutiveFailures++;
      if (consecutiveFailures >= 3) {
        log.error(
          `[${label}] Preimage lookup: 3 consecutive failures, interrupting`,
        );
        interrupt();
      }
    };

    const POLL_INTERVAL_MS = 10_000;
    const intervalId = setInterval(() => void poll(), POLL_INTERVAL_MS);
    const initialTimeoutId = setTimeout(() => void poll(), 1000);

    return () => {
      stopped = true;
      clearInterval(intervalId);
      clearTimeout(initialTimeoutId);
    };
  });
}

// ── Rate limiter (sliding window) ─────────────────────────

const SUBMIT_WINDOW_MS = 10_000;
const SUBMIT_MAX_PER_WINDOW = 20;

function createSubmitRateLimiter(): { allow: () => boolean } {
  const timestamps: number[] = [];
  return {
    allow() {
      const now = Date.now();
      while (timestamps.length > 0 && timestamps[0] <= now - SUBMIT_WINDOW_MS) {
        timestamps.shift();
      }
      if (timestamps.length >= SUBMIT_MAX_PER_WINDOW) {
        return false;
      }
      timestamps.push(now);
      return true;
    },
  };
}

// ── Helpers ────────────────────────────────────────────────

/** Strip the `.dot` suffix to get the bare label (e.g. "mytestapp.dot" → "mytestapp"). */
function identifierToLabel(identifier: string): string {
  return identifier.slice(0, -".dot".length);
}

/** Build a full URL for a .dot product on the current environment. */
function buildDotTargetUrl(label: string, pathname: string): string {
  const suffix = pathname ? "/" + pathname : "";
  // Local gateway: HTTPS via Caddy (foo.dot.li.localhost).
  if (
    window.location.hostname === `${BASE_DOMAIN}.localhost` ||
    window.location.hostname.endsWith(`.${BASE_DOMAIN}.localhost`)
  ) {
    const portSuffix = window.location.port ? `:${window.location.port}` : "";
    return `${window.location.protocol}//${label}.${BASE_DOMAIN}.localhost${portSuffix}${suffix}`;
  }
  if (isLocalhost) {
    return `http://${label}.localhost:${window.location.port}${suffix}`;
  }
  return `${window.location.protocol}//${label}.${BASE_DOMAIN}${suffix}`;
}

/** Bare host origin without any product subdomain (e.g. `http://localhost:5173` or `https://dot.li`). */
function getHostOrigin(): string {
  // Local gateway: HTTPS via Caddy.
  if (
    window.location.hostname === `${BASE_DOMAIN}.localhost` ||
    window.location.hostname.endsWith(`.${BASE_DOMAIN}.localhost`)
  ) {
    const portSuffix = window.location.port ? `:${window.location.port}` : "";
    return `${window.location.protocol}//${BASE_DOMAIN}.localhost${portSuffix}`;
  }
  if (isLocalhost) {
    return `http://localhost:${window.location.port}`;
  }
  return `${window.location.protocol}//${BASE_DOMAIN}`;
}

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

    // Validate origin — only allow *.dot.li and *.localhost origins
    try {
      const url = new URL(event.origin);
      const h = url.hostname;
      const allowed =
        h.endsWith(`.${BASE_DOMAIN}`) ||
        h === BASE_DOMAIN ||
        h === "localhost" ||
        h.endsWith(".localhost");
      if (!allowed) {
        log.warn(
          `[dot.li] Rejected nested bridge from disallowed origin: ${event.origin}`,
        );
        return;
      }
    } catch {
      return;
    }

    // Cap the number of nested bridges
    if (knownWindows.size >= MAX_NESTED_BRIDGES) {
      log.warn(
        `[dot.li] Nested bridge limit reached (max ${String(MAX_NESTED_BRIDGES)}), ignoring`,
      );
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
