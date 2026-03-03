// dot.li — CAR archive parsing + MIME type detection
//
// Parses IPFS CAR (Content Addressable aRchive) files into a file map.
// Ported from context__desktop/src/domains/product/ipfs/service.ts

import { CarReader } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import type { CID } from "multiformats/cid";

export type ArchiveFiles = Record<string, Uint8Array>;

// ── MIME types ─────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  xml: "application/xml",
  txt: "text/plain",
  pdf: "application/pdf",
};

export function getMimeType(path: string): string {
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return "application/octet-stream";
  const ext = path.substring(lastDot + 1).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

// ── CAR detection ──────────────────────────────────────────

export function isCarFile(buffer: Uint8Array): boolean {
  if (buffer.length < 10) return false;

  let offset = 0;
  let shift = 0;
  let headerLen = 0;

  while (offset < buffer.length && offset < 9) {
    const byte = buffer[offset];
    if (byte === undefined) return false;
    headerLen |= (byte & 0x7f) << shift;
    offset++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }

  if (buffer.length < offset + headerLen) return false;

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

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

export async function parseCarFile(
  buffer: Uint8Array,
): Promise<ArchiveFiles> {
  const reader = await CarReader.fromBytes(buffer);
  const [rootCid] = await reader.getRoots();

  if (!rootCid) {
    throw new Error("CAR file has no roots");
  }

  const files: ArchiveFiles = {};

  async function getChunkData(cid: CID): Promise<Uint8Array> {
    const block = await reader.get(cid);
    if (!block) return new Uint8Array(0);

    try {
      const node = dagPb.decode(block.bytes);
      return node.Data
        ? (UnixFS.unmarshal(node.Data).data ?? new Uint8Array(0))
        : new Uint8Array(0);
    } catch {
      return block.bytes;
    }
  }

  async function processNode(cid: CID, path: string): Promise<void> {
    const block = await reader.get(cid);
    if (!block) return;

    try {
      const node = dagPb.decode(block.bytes);
      const uf = node.Data ? UnixFS.unmarshal(node.Data) : null;
      const isDirectory = uf?.type === "directory";
      const isFile = !uf || uf.type === "file" || uf.type === "raw";

      if (isDirectory || (!uf && node.Links.length > 0)) {
        for (const link of node.Links) {
          if (link.Name) {
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
                await Promise.all(
                  node.Links.map((link) => getChunkData(link.Hash)),
                ),
              );

        files[path] = content;
      }
    } catch {
      files[path] = block.bytes;
    }
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
  return isCarFile(buffer)
    ? parseCarFile(buffer)
    : { "index.html": buffer };
}
