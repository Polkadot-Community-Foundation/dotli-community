// dot.li — Service Worker smoldot provider bridge
//
// Creates a JsonRpcProvider that forwards JSON-RPC messages to the Service Worker
// via MessagePort. The SW runs smoldot and the Asset Hub parachain, bridging
// JSON-RPC between this provider and the smoldot chain instance.

import type { JsonRpcProvider } from "@polkadot-api/json-rpc-provider";
import { getSyncProvider } from "@polkadot-api/json-rpc-provider-proxy";
import { TIMEOUTS } from "@dotli/config/config";

/**
 * Message types for main thread ↔ SW smoldot communication.
 */
export interface SmoldotConnectMessage {
  type: "SMOLDOT_CONNECT";
}

export interface SmoldotStatusMessage {
  type: "SMOLDOT_STATUS";
}

export interface SmoldotRpcSend {
  type: "SMOLDOT_RPC_SEND";
  message: string;
}

export interface SmoldotRpcResponse {
  type: "SMOLDOT_RPC_RESPONSE";
  message: string;
}

export interface SmoldotStatusReply {
  type: "SMOLDOT_STATUS_REPLY";
  ready: boolean;
}

export interface SmoldotError {
  type: "SMOLDOT_ERROR";
  error: string;
}

/**
 * Check if the SW has smoldot ready.
 * Returns true if the SW is controlling and has an initialized smoldot chain.
 */
export async function isSwSmoldotReady(): Promise<boolean> {
  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      resolve(false);
    }, TIMEOUTS.SW_SMOLDOT_READY);

    const channel = new MessageChannel();
    channel.port1.onmessage = (evt: MessageEvent): void => {
      clearTimeout(timeout);
      const data = evt.data as SmoldotStatusReply | null;
      resolve(data?.ready === true);
      channel.port1.close();
    };

    controller.postMessage(
      { type: "SMOLDOT_STATUS" } satisfies SmoldotStatusMessage,
      [channel.port2],
    );
  });
}

/**
 * Create a JsonRpcProvider that bridges JSON-RPC to the SW's smoldot instance.
 *
 * Uses getSyncProvider (same wrapper as getSmProvider) for reconnection handling.
 * The SW manages the smoldot lifecycle; this provider just forwards messages.
 */
export function getSwSmoldotProvider(): JsonRpcProvider {
  return getSyncProvider(async () => {
    const controller = navigator.serviceWorker.controller;
    if (!controller) {
      throw new Error("No service worker controller");
    }

    // Create a dedicated MessageChannel for this connection
    const channel = new MessageChannel();

    // Wait for the SW to confirm the connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("SW smoldot connection timeout"));
      }, TIMEOUTS.SW_SMOLDOT_CONNECT);

      channel.port1.onmessage = (evt: MessageEvent): void => {
        const data = evt.data as { type: string } | null;
        if (data?.type === "SMOLDOT_CONNECTED") {
          clearTimeout(timeout);
          resolve();
        }
        if (data?.type === "SMOLDOT_ERROR") {
          clearTimeout(timeout);
          reject(new Error((evt.data as SmoldotError).error));
        }
      };

      controller.postMessage(
        { type: "SMOLDOT_CONNECT" } satisfies SmoldotConnectMessage,
        [channel.port2],
      );
    });

    // Return the sync provider callback
    return (listener: (message: string) => void, onError: () => void) => {
      let connected = true;

      channel.port1.onmessage = (evt: MessageEvent): void => {
        if (!connected) {
          return;
        }
        const data = evt.data as {
          type: string;
          message?: string;
          error?: string;
        } | null;
        if (
          data?.type === "SMOLDOT_RPC_RESPONSE" &&
          data.message !== undefined
        ) {
          listener(data.message);
        }
        if (data?.type === "SMOLDOT_ERROR") {
          onError();
        }
      };

      return {
        send(msg: string): void {
          channel.port1.postMessage({
            type: "SMOLDOT_RPC_SEND",
            message: msg,
          } satisfies SmoldotRpcSend);
        },
        disconnect(): void {
          connected = false;
          channel.port1.postMessage({ type: "SMOLDOT_DISCONNECT" });
          channel.port1.close();
        },
      };
    };
  });
}
