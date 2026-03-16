// dot.li — Fast CID resolution via HTTP JSON-RPC state_call
//
// Resolves domain->CID by making a single HTTP POST to a public
// Asset Hub Paseo RPC node using the `state_call` JSON-RPC method.
// Bypasses WebSocket + chainHead subscription overhead entirely.
//
// Uses metadata-derived SCALE codecs (from papi) for encoding/decoding.
// The metadata is bundled as a Vite asset and parsed at module init.
//
// To refresh metadata: `npm run update-metadata`

import {
  CONTRACTS,
  ASSET_HUB_PASEO_RPC,
  DUMMY_ORIGIN,
  TIMEOUTS,
} from "./config";
import {
  namehash,
  encodeFunctionCall,
  decodeBytes,
  decodeIpfsContenthash,
} from "./abi";
import {
  encodeReviveApiCall,
  decodeContractResult,
} from "./codegen/revive-api";
import { dur } from "./perf";
import { log } from "./log";

// ── Gateway resolution via HTTP state_call ──────────────────

/**
 * Resolve a .dot name to an IPFS CID via HTTP JSON-RPC state_call.
 *
 * Makes a single HTTP POST per endpoint — no WebSocket, no chainHead
 * subscription, no polkadot-api client overhead. Falls through to the
 * next endpoint on failure; returns null if all fail (smoldot handles it).
 */
export async function resolveViaGateway(label: string): Promise<string | null> {
  const start = performance.now();

  const domain = `${label}.dot`;
  const node = namehash(domain);
  const calldata = encodeFunctionCall("contenthash", node);

  // Encode params using metadata-derived SCALE codec
  const params = await encodeReviveApiCall(
    DUMMY_ORIGIN,
    CONTRACTS.DOTNS_CONTENT_RESOLVER,
    0n,
    { ref_time: 18446744073709551615n, proof_size: 18446744073709551615n },
    18446744073709551615n,
    calldata,
  );
  log.warn(`[dot.li gateway] Params encoded (${dur(start)})`);

  for (const wsUrl of ASSET_HUB_PASEO_RPC) {
    const httpUrl = wsUrl.replace("wss://", "https://");
    try {
      const fetchStart = performance.now();
      const response = await fetch(httpUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "state_call",
          params: ["ReviveApi_call", params],
        }),
        signal: AbortSignal.timeout(TIMEOUTS.GATEWAY_RESOLVE),
      });

      if (!response.ok) {
        log.warn(
          `[dot.li gateway] HTTP ${String(response.status)} from ${httpUrl} (${dur(fetchStart)})`,
        );
        continue;
      }

      const json = (await response.json()) as {
        result?: string;
        error?: { message?: string; code?: number };
      };
      log.warn(`[dot.li gateway] RPC response received (${dur(fetchStart)})`);

      if (json.error) {
        log.warn(
          `[dot.li gateway] RPC error: ${json.error.message ?? "unknown"}`,
        );
        continue;
      }

      if (json.result === undefined || typeof json.result !== "string") {
        log.warn(`[dot.li gateway] No result in RPC response`);
        continue;
      }

      const returnData = await decodeContractResult(json.result);
      if (returnData === null) {
        log.warn(
          `[dot.li gateway] Contract call failed or reverted (${dur(fetchStart)})`,
        );
        continue;
      }

      const contenthashBytes = decodeBytes(returnData);
      const cid = decodeIpfsContenthash(contenthashBytes);
      log.warn(
        `[dot.li gateway] Resolved CID (${dur(start)}): ${cid ?? "null"}`,
      );
      return cid;
    } catch (err) {
      log.warn(`[dot.li gateway] Failed ${httpUrl} (${dur(start)}):`, err);
      continue;
    }
  }

  log.warn(`[dot.li gateway] All endpoints failed (${dur(start)})`);
  return null;
}
