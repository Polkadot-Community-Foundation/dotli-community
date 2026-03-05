// dot.li — Metadata-driven SCALE codecs for ReviveApi_call
//
// Uses the bundled Asset Hub Paseo metadata (fetched by `papi add`)
// to build correct SCALE encode/decode functions at module init.
//
// This replaces manual SCALE encoding — the metadata is the single
// source of truth for parameter types (e.g. compact u64 in Weight).
//
// To refresh: `npm run update-metadata`

import {
  decAnyMetadata,
  unifyMetadata,
} from "@polkadot-api/substrate-bindings";
import {
  getLookupFn,
  getDynamicBuilder,
} from "@polkadot-api/metadata-builders";
import { toHex, fromHex } from "@polkadot-api/utils";
import { Binary } from "polkadot-api";

import metadataUrl from "../../.papi/metadata/ah.scale?url";

// Codec built lazily on first use (metadata fetch + parse + build)
let codecPromise: Promise<{
  encodeInput: (args: unknown[]) => Uint8Array;
  decodeOutput: (hex: string) => ContractResult;
}> | null = null;

interface ContractResult {
  result:
    | { success: true; value: { flags: number; data: Binary } }
    | { success: false; value: unknown };
}

async function buildCodec(): Promise<{
  encodeInput: (args: unknown[]) => Uint8Array;
  decodeOutput: (hex: string) => ContractResult;
}> {
  const response = await fetch(metadataUrl);
  const buffer = await response.arrayBuffer();
  const raw = decAnyMetadata(new Uint8Array(buffer));
  const metadata = unifyMetadata(raw);
  const lookupFn = getLookupFn(metadata);
  const builder = getDynamicBuilder(lookupFn);
  const codec = builder.buildRuntimeCall("ReviveApi", "call");

  return {
    encodeInput: (args: unknown[]): Uint8Array => codec.args.enc(args),
    decodeOutput: (hex: string): ContractResult =>
      codec.value.dec(fromHex(hex)) as ContractResult,
  };
}

function getCodec(): Promise<{
  encodeInput: (args: unknown[]) => Uint8Array;
  decodeOutput: (hex: string) => ContractResult;
}> {
  codecPromise ??= buildCodec();
  return codecPromise;
}

// Start fetching metadata immediately when this module is imported
void getCodec();

/**
 * SCALE-encode ReviveApi_call parameters using metadata-derived codecs.
 *
 * Returns hex string (with 0x prefix) ready for state_call RPC.
 */
export async function encodeReviveApiCall(
  origin: string,
  dest: `0x${string}`,
  value: bigint,
  gasLimit: { ref_time: bigint; proof_size: bigint } | undefined,
  storageDepositLimit: bigint | undefined,
  inputData: `0x${string}`,
): Promise<string> {
  const codec = await getCodec();
  const encoded = codec.encodeInput([
    origin,
    Binary.fromHex(dest),
    value,
    gasLimit,
    storageDepositLimit,
    Binary.fromHex(inputData),
  ]);
  return toHex(encoded);
}

/**
 * SCALE-decode a ContractResult from state_call response.
 *
 * Returns the EVM return data as hex, or null if the call failed/reverted.
 */
export async function decodeContractResult(
  resultHex: string,
): Promise<`0x${string}` | null> {
  const codec = await getCodec();
  try {
    const result = codec.decodeOutput(resultHex);
    if (!result.result.success) {
      return null;
    }
    const { flags, data } = result.result.value;
    if ((flags & 1) === 1) {
      return null; // Reverted
    }
    return data.asHex();
  } catch {
    return null;
  }
}
