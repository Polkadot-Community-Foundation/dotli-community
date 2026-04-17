// dot.li — CAR archive parsing + MIME type detection
//
// Parses IPFS CAR (Content Addressable aRchive) files into a file map.
// Ported from context__desktop/src/domains/product/ipfs/service.ts

import { CarReader } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import type { CID } from "multiformats/cid";
import { concatBytes } from "@noble/hashes/utils.js";

export type ArchiveFiles = Record<string, Uint8Array>;

// ── CAR detection ──────────────────────────────────────────

export function isCarFile(buffer: Uint8Array): boolean {
  if (buffer.length < 10) {
    return false;
  }

  let offset = 0;
  let shift = 0;
  let headerLen = 0;

  while (offset < buffer.length && offset < 9) {
    const byte = buffer[offset] as number | undefined;
    if (byte === undefined) {
      return false;
    }
    headerLen |= (byte & 0x7f) << shift;
    offset++;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }

  if (buffer.length < offset + headerLen) {
    return false;
  }

  const headerStart = offset;
  // Check for CBOR map with "roots" key
  return (
    buffer[headerStart] === 0xa2 &&
    buffer[headerStart + 1] === 0x65 &&
    buffer[headerStart + 2] === 0x72 &&
    buffer[headerStart + 3] === 0x6f &&
    buffer[headerStart + 4] === 0x6f &&
    buffer[headerStart + 5] === 0x74 &&
    buffer[headerStart + 6] === 0x73
  );
}

// ── CAR parsing ────────────────────────────────────────────

// CID codec constants
const DAG_PB = 0x70;
const RAW = 0x55;

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

export async function parseCarFile(buffer: Uint8Array): Promise<ArchiveFiles> {
  const reader = await CarReader.fromBytes(buffer);
  const roots = await reader.getRoots();
  const rootCid = roots[0] as
    | Awaited<ReturnType<typeof reader.getRoots>>[number]
    | undefined;

  if (rootCid === undefined) {
    throw new Error("CAR file has no roots");
  }

  const files: ArchiveFiles = {};

  // Failure rules:
  //   - Missing CAR blocks throw — a dangling reference is a malformed CAR,
  //     not a partial-success situation.
  //   - dag-pb decode failures throw — never substitute raw protobuf bytes
  //     as user content.
  //   - Unknown codecs at non-root throw — we don't guess what the bytes
  //     mean, the caller must surface the failure.

  /** Read the raw data bytes from a chunk CID (used for multi-block files). */
  async function getChunkData(cid: CID): Promise<Uint8Array> {
    const block = await reader.get(cid);
    if (!block) {
      throw new Error(
        `CAR is missing block for ${cid.toString()} (referenced as a chunk)`,
      );
    }

    // Raw codec — block bytes ARE the content
    if (cid.code === RAW) {
      return block.bytes;
    }

    // dag-pb — extract UnixFS data payload. Decode failures are fatal.
    if (cid.code === DAG_PB) {
      const node = dagPb.decode(block.bytes);
      return node.Data
        ? (UnixFS.unmarshal(node.Data).data ?? new Uint8Array(0))
        : new Uint8Array(0);
    }

    throw new Error(
      `Unsupported chunk codec 0x${cid.code.toString(16)} for ${cid.toString()}`,
    );
  }

  /** Recursively walk a DAG node, collecting files into `files`. */
  async function processNode(cid: CID, path: string): Promise<void> {
    const block = await reader.get(cid);
    if (!block) {
      throw new Error(
        `CAR is missing block for ${cid.toString()} (path="${path}")`,
      );
    }

    // Raw codec — block bytes ARE the file content (leaf node).
    // Special case: if the raw bytes are themselves a CAR file (content
    // was uploaded as a binary CAR archive), parse it recursively.
    if (cid.code === RAW) {
      if (isCarFile(block.bytes)) {
        const inner = await parseCarFile(block.bytes);
        for (const [p, data] of Object.entries(inner)) {
          files[p] = data;
        }
        return;
      }
      files[path || "index.html"] = block.bytes;
      return;
    }

    if (cid.code !== DAG_PB) {
      throw new Error(
        `Unsupported codec 0x${cid.code.toString(16)} at path="${path}" (${cid.toString()})`,
      );
    }

    // dag-pb decode is fatal on failure.
    const node = dagPb.decode(block.bytes);
    const uf = node.Data ? UnixFS.unmarshal(node.Data) : null;
    const isDirectory =
      uf?.type === "directory" || uf?.type === "hamt-sharded-directory";
    const isFile = !uf || uf.type === "file" || uf.type === "raw";

    if (isDirectory) {
      for (const link of node.Links) {
        if (link.Name !== undefined && link.Name !== "") {
          await processNode(link.Hash, joinPath(path, link.Name));
        }
      }
      return;
    }

    if (isFile) {
      const content =
        node.Links.length === 0
          ? (uf?.data ?? new Uint8Array(0))
          : concatBytes(
              ...(await Promise.all(
                node.Links.map((link) => getChunkData(link.Hash)),
              )),
            );

      // If the assembled file content is itself a CAR archive (content
      // was uploaded as a binary CAR), parse it recursively to extract
      // the actual files instead of storing the raw CAR bytes.
      if (isCarFile(content)) {
        const inner = await parseCarFile(content);
        for (const [p, data] of Object.entries(inner)) {
          files[p] = data;
        }
      } else {
        files[path || "index.html"] = content;
      }
      return;
    }

    // UnixFS classified the node as something else (symlink/metadata) —
    // fail loud rather than guess at how to render it.
    throw new Error(
      `Unsupported UnixFS node type "${uf.type}" at path="${path}"`,
    );
  }

  await processNode(rootCid, "");
  return files;
}

/**
 * Parse an IPFS response — if it's a CAR file, extract the archive;
 * otherwise treat the raw bytes as a single index.html.
 */
export async function parseIpfsResponse(
  buffer: Uint8Array,
): Promise<ArchiveFiles> {
  return isCarFile(buffer) ? parseCarFile(buffer) : { "index.html": buffer };
}

// ── Archive packing (for SW transfer) ────────────────────────

export interface PackedArchive {
  packed: ArrayBuffer;
  index: { p: string; o: number; l: number }[];
}

/**
 * Pack all archive files into a single ArrayBuffer with an offset index.
 * Transfers 1 Transferable instead of N, reducing structured clone overhead
 * from O(n_files) to O(1) when sending to the Service Worker.
 */
export function packArchive(files: ArchiveFiles): PackedArchive {
  const entries = Object.entries(files);
  const index: { p: string; o: number; l: number }[] = [];
  let totalSize = 0;
  for (const [, data] of entries) {
    totalSize += data.byteLength;
  }
  const packed = new ArrayBuffer(totalSize);
  const packedView = new Uint8Array(packed);
  let offset = 0;
  for (const [filePath, data] of entries) {
    index.push({ p: filePath, o: offset, l: data.byteLength });
    packedView.set(data, offset);
    offset += data.byteLength;
  }
  return { packed, index };
}
