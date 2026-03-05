// dot.li — Fast CID resolution via public RPC endpoint
//
// Resolves domain->CID by connecting directly to a public Asset Hub Paseo
// RPC node via WebSocket. Skips smoldot chain sync (~14s) entirely.
// Used as a fast path on cold start; smoldot verifies in the background.

import { getWsProvider } from "polkadot-api/ws-provider/web";
import { createClient, type PolkadotClient } from "polkadot-api";
import { Binary } from "polkadot-api";
import {
  CONTRACTS,
  DRY_RUN_WEIGHT_LIMIT,
  DRY_RUN_STORAGE_LIMIT,
  DUMMY_ORIGIN,
  ASSET_HUB_PASEO_RPC,
} from "./config";
import { namehash, encodeFunctionCall, decodeBytes } from "./abi";
import {
  decode as decodeContentHash,
  getCodec,
} from "@ensdomains/content-hash";

function dur(start: number): string {
  return `${(performance.now() - start).toFixed(0)}ms`;
}

const GATEWAY_TIMEOUT_MS = 8_000;

// ── Revive dry-run call (same logic as resolve.ts) ───────────

interface ReviveExecResult {
  value?: ReviveOkResult;
  isOk?: boolean;
  ok?: ReviveOkResult;
  result?: ReviveExecResult;
}

interface ReviveOkResult {
  flags?: { toString?: () => string } | number | string;
  data?:
    | string
    | { asHex: () => string }
    | { toHex: () => string }
    | Uint8Array;
}

async function reviveCall(
  api: ReturnType<PolkadotClient["getUnsafeApi"]>,
  contractAddress: string,
  encodedData: `0x${string}`,
): Promise<`0x${string}`> {
  const result = (await api.apis.ReviveApi.call(
    DUMMY_ORIGIN,
    Binary.fromHex(contractAddress as `0x${string}`),
    0n,
    DRY_RUN_WEIGHT_LIMIT,
    DRY_RUN_STORAGE_LIMIT,
    Binary.fromHex(encodedData),
  )) as { result: ReviveExecResult };

  const execResult: ReviveExecResult = result.result;
  const ok: ReviveOkResult | null =
    execResult.value ??
    (execResult.isOk === true
      ? (execResult as unknown as ReviveOkResult)
      : null) ??
    execResult.ok ??
    null;

  if (ok === null) {
    throw new Error("Revive call failed: no result");
  }

  const flagsRaw = ok.flags;
  const flagsStr =
    typeof flagsRaw === "object" && typeof flagsRaw.toString === "function"
      ? flagsRaw.toString()
      : String(flagsRaw ?? 0);
  if ((BigInt(flagsStr) & 1n) === 1n) {
    throw new Error("Contract execution reverted");
  }

  const data = ok.data;
  if (typeof data === "string") {
    return data as `0x${string}`;
  }
  if (
    data !== undefined &&
    "asHex" in data &&
    typeof data.asHex === "function"
  ) {
    return data.asHex() as `0x${string}`;
  }
  if (
    data !== undefined &&
    "toHex" in data &&
    typeof data.toHex === "function"
  ) {
    return data.toHex() as `0x${string}`;
  }
  if (data instanceof Uint8Array) {
    return ("0x" +
      Array.from(data)
        .map((b: number) => b.toString(16).padStart(2, "0"))
        .join("")) as `0x${string}`;
  }
  return "0x";
}

// ── Gateway resolution ───────────────────────────────────────

/**
 * Resolve a .dot name to an IPFS CID via a public RPC endpoint.
 * Connects via WebSocket, makes a single dry-run call, and disconnects.
 * Has a built-in timeout to avoid blocking the critical path.
 */
export async function resolveViaGateway(label: string): Promise<string | null> {
  const start = performance.now();

  return new Promise<string | null>((resolve) => {
    const timeout = setTimeout(() => {
      console.warn(
        `[dot.li gateway] Timed out after ${String(GATEWAY_TIMEOUT_MS)}ms`,
      );
      cleanup();
      resolve(null);
    }, GATEWAY_TIMEOUT_MS);

    let client: PolkadotClient | null = null;

    function cleanup(): void {
      clearTimeout(timeout);
      client?.destroy();
      client = null;
    }

    void (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- will migrate in PAPI v2
        const provider = getWsProvider(ASSET_HUB_PASEO_RPC);
        client = createClient(provider);

        await client.getFinalizedBlock();
        console.warn(`[dot.li gateway] Connected (${dur(start)})`);

        const api = client.getUnsafeApi();
        const domain = `${label}.dot`;
        const node = namehash(domain);
        const calldata = encodeFunctionCall("contenthash", node);

        const callStart = performance.now();
        const result = await reviveCall(
          api,
          CONTRACTS.DOTNS_CONTENT_RESOLVER,
          calldata,
        );
        console.warn(`[dot.li gateway] contenthash() call: ${dur(callStart)}`);

        const contenthashBytes = decodeBytes(result);
        const hex = contenthashBytes.startsWith("0x")
          ? contenthashBytes.slice(2)
          : contenthashBytes;

        if (!hex || hex === "0" || hex.length < 4) {
          console.warn(
            `[dot.li gateway] No content hash found (${dur(start)})`,
          );
          cleanup();
          resolve(null);
          return;
        }

        const codec = getCodec(hex);
        if (codec !== "ipfs") {
          cleanup();
          resolve(null);
          return;
        }

        const cid = decodeContentHash(hex);
        console.warn(`[dot.li gateway] Resolved CID (${dur(start)}): ${cid}`);
        cleanup();
        resolve(cid || null);
      } catch (err) {
        console.warn(`[dot.li gateway] Failed (${dur(start)}):`, err);
        cleanup();
        resolve(null);
      }
    })();
  });
}
