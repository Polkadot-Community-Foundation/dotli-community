// dot.li — Shared contract storage reading utilities
//
// Low-level functions for reading Solidity storage slots from a Revive
// (EVM-on-Polkadot) contract via polkadot-api's UnsafeApi. Used by both
// the smoldot-based resolver and the trusted RPC resolver.

import { Binary, type PolkadotClient } from "polkadot-api";
import {
  computeMappingSlot,
  addToSlot,
  extractAddress,
  decodeBytesSlot,
} from "./abi";

export type StatusCallback = (status: string) => void;
export type UnsafeApi = ReturnType<PolkadotClient["getUnsafeApi"]>;

/**
 * Structured resolver phase events. Callers that want to advance a
 * multi-step loading indicator should listen to these instead of
 * parsing status strings with regex — the string formats are for
 * humans and change freely, the phase tokens are a stable contract.
 */
export type ResolvePhase =
  | "light-client-starting"
  | "relay-chain-adding"
  | "asset-hub-connecting"
  | "asset-hub-syncing"
  | "asset-hub-ready"
  | "resolving-content";

export type PhaseCallback = (phase: ResolvePhase) => void;

/**
 * Map a human-readable resolver status string back to its `ResolvePhase`.
 *
 * The resolver itself now emits phase events directly via its `onPhase`
 * callback, but callers that bridge status across a worker/iframe
 * boundary (where a structured callback can't cross easily) can use
 * this helper to reconstruct the phase on the receiving side without
 * duplicating the regex in every consumer. Returns `null` for status
 * messages that don't map to a known phase.
 */
export function statusToPhase(message: string): ResolvePhase | null {
  if (message.startsWith("Starting light client")) {
    return "light-client-starting";
  }
  if (message.startsWith("Adding Paseo relay")) {
    return "relay-chain-adding";
  }
  if (
    message.startsWith("Connecting to Asset Hub") ||
    message.includes("Discovering") ||
    message.includes("peers")
  ) {
    return "asset-hub-connecting";
  }
  if (
    message.startsWith("Syncing with Asset Hub") ||
    message.startsWith("Syncing #")
  ) {
    return "asset-hub-syncing";
  }
  if (
    message.startsWith("Synced to") ||
    message.startsWith("Connected to Asset Hub")
  ) {
    return "asset-hub-ready";
  }
  if (message.includes("Resolving content")) {
    return "resolving-content";
  }
  return null;
}

// ── Storage reads ────────────────────────────────────────────

export function extractBytes(result: unknown): Uint8Array | null {
  if (result === null || result === undefined) {
    return null;
  }
  if (result instanceof Uint8Array) {
    return result;
  }
  if (typeof result !== "object") {
    return null;
  }
  const obj = result as Record<string, unknown>;
  if (typeof obj.asBytes === "function") {
    return new Uint8Array((result as Binary).asBytes());
  }
  if ("success" in obj) {
    if (obj.success !== true) {
      return null;
    }
    return extractBytes(obj.value);
  }
  if ("value" in obj) {
    return extractBytes(obj.value);
  }
  return null;
}

export async function readStorageSlot(
  api: UnsafeApi,
  contractAddress: string,
  slotKey: `0x${string}`,
): Promise<Uint8Array | null> {
  // Use at:"best" to read from the latest block, not the finalized block.
  // During cold sync, the finalized block may be behind the chain tip.
  const result: unknown = await api.apis.ReviveApi.get_storage(
    Binary.fromHex(contractAddress as `0x${string}`),
    Binary.fromHex(slotKey),
    { at: "best" },
  );
  return extractBytes(result);
}

export async function readMappingBytes(
  api: UnsafeApi,
  contractAddress: string,
  mappingKey: `0x${string}`,
  mappingSlot: number,
): Promise<Uint8Array | null> {
  const baseSlotKey = computeMappingSlot(mappingKey, mappingSlot);
  const baseData = await readStorageSlot(api, contractAddress, baseSlotKey);
  if (baseData === null) {
    return null;
  }
  const decoded = decodeBytesSlot(baseData, baseSlotKey);
  if (decoded === null) {
    return null;
  }
  if (decoded.inline) {
    return decoded.data;
  }
  const slotsNeeded = Math.ceil(decoded.length / 32);
  const result = new Uint8Array(decoded.length);
  for (let i = 0; i < slotsNeeded; i++) {
    const slotKey = addToSlot(decoded.dataSlot, i);
    const slotData = await readStorageSlot(api, contractAddress, slotKey);
    // If any slot read returns null mid-way, throw — silently zero-padding
    // the gap would return a corrupted contenthash that reads upstream as
    // "name not found", masking the actual RPC failure.
    if (slotData === null) {
      throw new Error(
        `Partial storage read at slot ${String(i)}/${String(slotsNeeded)} for mapping bytes (contract=${contractAddress})`,
      );
    }
    const offset = i * 32;
    const copyLen = Math.min(32, decoded.length - offset);
    result.set(slotData.slice(0, copyLen), offset);
  }
  return result;
}

export async function readMappingAddress(
  api: UnsafeApi,
  contractAddress: string,
  mappingKey: `0x${string}`,
  mappingSlot: number,
): Promise<string | null> {
  const slotKey = computeMappingSlot(mappingKey, mappingSlot);
  const data = await readStorageSlot(api, contractAddress, slotKey);
  if (data === null) {
    return null;
  }
  const address = extractAddress(data);
  if (address === "0x0000000000000000000000000000000000000000") {
    return null;
  }
  return address;
}
