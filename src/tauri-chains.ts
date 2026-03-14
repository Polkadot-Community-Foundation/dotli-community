// dot.li — Tauri chain provider
//
// Creates JsonRpcProviders backed by the Rust smoldot bridge.
// Used instead of the JS smoldot when running in Tauri.

import type { JsonRpcProvider } from "@polkadot-api/json-rpc-provider";

// Well-known genesis hashes supported by the Rust backend
const SUPPORTED = new Set([
  "0x77afd6190f1554ad45fd0d31aee62aacc33c6db0ea801129acb813f913e0764f", // Paseo
  "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2", // Asset Hub Paseo
  "0x91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3", // Polkadot
  "0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f", // Polkadot Asset Hub
]);

const providerCache = new Map<string, JsonRpcProvider>();

export function isTauriChainSupported(genesisHash: string): boolean {
  return SUPPORTED.has(genesisHash.toLowerCase());
}

/**
 * Create a JsonRpcProvider that routes JSON-RPC through the Rust smoldot bridge.
 *
 * - Calls `smoldot_connect` to add the chain (idempotent)
 * - Sends RPC via `rpc_send` Tauri command
 * - Receives responses via `smoldot-response` Tauri event
 */
export function createTauriChainProvider(
  genesisHash: string,
): JsonRpcProvider | null {
  const key = genesisHash.toLowerCase();
  if (!SUPPORTED.has(key)) {
    return null;
  }

  const cached = providerCache.get(key);
  if (cached) {
    return cached;
  }

  const provider: JsonRpcProvider = (onMessage) => {
    let unlisten: (() => void) | null = null;
    let connected = true;

    // Connect and start listening for responses
    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");

      await invoke("smoldot_connect", { genesisHash: key });

      const unlistenFn = await listen<{
        chain_key: string;
        message: string;
      }>("smoldot-response", (event) => {
        if (connected && event.payload.chain_key === key) {
          onMessage(event.payload.message);
        }
      });

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `connected` may be set to false by disconnect() before this async block resolves
      if (connected) {
        unlisten = unlistenFn;
      } else {
        unlistenFn();
      }
    })();

    return {
      send(message: string) {
        if (!connected) {
          return;
        }
        void import("@tauri-apps/api/core").then(({ invoke }) =>
          invoke("rpc_send", { chainKey: key, message }),
        );
      },
      disconnect() {
        connected = false;
        unlisten?.();
        unlisten = null;
      },
    };
  };

  providerCache.set(key, provider);
  return provider;
}
