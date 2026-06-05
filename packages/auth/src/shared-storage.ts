// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SiteId } from "@dotli/config/config";
import {
  clearSharedAuthStorage,
  readSharedAuthStorage,
  subscribeSharedAuthStorage,
  writeSharedAuthStorage,
} from "@dotli/protocol/client";
import type { StorageAdapter } from "@novasamatech/storage-adapter";
import { fromPromise } from "neverthrow";

type StorageListener = (value: string | null) => unknown;

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Storage adapter backed by the shared host-window localStorage (on
 * `host.<root-domain>`) instead of the per-subdomain localStorage.
 *
 * - All read/write/clear calls proxy through the protocol iframe.
 * - In-process subscribers receive updates from same-tab writes via a
 *   local emit in the write/clear pipeline.
 * - Cross-tab subscribers on the same root domain receive updates via the
 *   protocol client's `subscribeSharedAuthStorage`, which is driven by a
 *   `BroadcastChannel` running inside the host iframe. This preserves the
 *   cross-tab contract of the upstream `@novasamatech/storage-adapter`
 *   `createLocalStorageAdapter`, which used the `storage` event.
 */
export function createSharedAuthStorageAdapter(siteId: SiteId): StorageAdapter {
  const listeners = new Map<string, Set<StorageListener>>();
  let broadcastUnsubscribe: (() => void) | null = null;

  function emit(key: string, value: string | null): void {
    const callbacks = listeners.get(key);
    if (!callbacks) {
      return;
    }
    for (const callback of callbacks) {
      callback(value);
    }
  }

  function ensureBroadcastSubscription(): void {
    if (broadcastUnsubscribe !== null) {
      return;
    }
    broadcastUnsubscribe = subscribeSharedAuthStorage((change) => {
      // Scope per-root-domain: ignore notifications from a different siteId.
      // This is already enforced in the host iframe (which only accepts its
      // own SITE_ID), but we filter defensively here too.
      if (change.siteId !== siteId) {
        return;
      }
      emit(change.key, change.value);
    });
  }

  return {
    read(key) {
      return fromPromise(readSharedAuthStorage(siteId, key), toError);
    },
    write(key, value) {
      // The iframe on `host.<root>` is the authoritative store: after a
      // write resolves, read back through the iframe before firing the
      // local `emit`. Trusting the local `value` we just tried to write
      // would let a same-tab subscriber observe an update that the
      // upstream storage quietly rejected (quota, validation, etc.). The
      // cross-tab BroadcastChannel listener handles other tabs. Here we
      // reconcile this tab against the source of truth.
      return fromPromise(
        writeSharedAuthStorage(siteId, key, value),
        toError,
      ).map(() => {
        void readSharedAuthStorage(siteId, key).then(
          (actual) => {
            emit(key, actual);
          },
          () => {
            // Read-back failed, so fall back to the value we intended.
            // The subsequent write or subscription tick will reconcile.
            emit(key, value);
          },
        );
      });
    },
    clear(key) {
      return fromPromise(clearSharedAuthStorage(siteId, key), toError).map(
        () => {
          void readSharedAuthStorage(siteId, key).then(
            (actual) => {
              emit(key, actual);
            },
            () => {
              emit(key, null);
            },
          );
        },
      );
    },
    subscribe(key, callback) {
      ensureBroadcastSubscription();

      const callbacks = listeners.get(key) ?? new Set<StorageListener>();
      callbacks.add(callback);
      listeners.set(key, callbacks);

      return () => {
        const current = listeners.get(key);
        if (!current) {
          return;
        }
        current.delete(callback);
        if (current.size === 0) {
          listeners.delete(key);
        }
      };
    },
  };
}
