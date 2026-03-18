// dot.li — IPFS gateway utilities
//
// Same API as polkadot-bulletin-chain/console-ui/src/lib/ipfs.ts

import { IPFS_GATEWAY } from "./config";

/**
 * Fetch content from IPFS by CID via HTTP gateway.
 */
export async function fetchFromIpfs(
  cid: string,
  gateway: string = IPFS_GATEWAY,
): Promise<{
  data: Uint8Array;
  contentType?: string;
}> {
  const url = `${gateway}/ipfs/${cid}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `IPFS fetch failed: HTTP ${String(response.status)} ${response.statusText}`,
    );
  }

  const contentType = response.headers.get("content-type") || undefined;
  const arrayBuffer = await response.arrayBuffer();

  return {
    data: new Uint8Array(arrayBuffer),
    contentType,
  };
}

/**
 * Fetch content as CAR archive from the IPFS gateway.
 * The gateway's ?format=car returns the entire directory tree in one response.
 */
export async function fetchCarFromIpfs(
  cid: string,
  gateway: string = IPFS_GATEWAY,
): Promise<Uint8Array> {
  const url = `${gateway}/ipfs/${cid}?format=car`;

  const response = await fetch(url, {
    headers: { Accept: "application/vnd.ipld.car" },
  });

  if (!response.ok) {
    throw new Error(
      `IPFS CAR fetch failed: HTTP ${String(response.status)} ${response.statusText}`,
    );
  }

  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Check if content exists on IPFS (HEAD request).
 */
export async function checkIpfsContent(
  cid: string,
  gateway: string = IPFS_GATEWAY,
): Promise<boolean> {
  const url = `${gateway}/ipfs/${cid}`;

  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get content info from IPFS (size, type) without downloading full content.
 */
export async function getIpfsContentInfo(
  cid: string,
  gateway: string = IPFS_GATEWAY,
): Promise<{
  exists: boolean;
  size?: number;
  contentType?: string;
} | null> {
  const url = `${gateway}/ipfs/${cid}`;

  try {
    const response = await fetch(url, { method: "HEAD" });

    if (!response.ok) {
      return { exists: false };
    }

    const contentLength = response.headers.get("content-length");
    const contentType = response.headers.get("content-type");

    return {
      exists: true,
      size: contentLength ? parseInt(contentLength, 10) : undefined,
      contentType: contentType || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Build IPFS gateway URL for a CID.
 */
export function buildIpfsUrl(
  cid: string,
  gateway: string = IPFS_GATEWAY,
): string {
  return `${gateway}/ipfs/${cid}`;
}
