// dotNS URL parsing utilities
//
// Parses .dot domain URLs in various formats (bare, with protocol, polkadot://)
// and identifies products by the canonical `.dot` TLD.
// URLs with other TLDs (dot.li, paseo.li, google.com, etc.) are regular websites.

export interface DotNsUrl {
  identifier: string; // e.g. "mytestapp.dot" (always ends with .dot)
  pathname: string; // e.g. "some/path?q=1#h=2" (no leading slash)
}

// ── Helpers ──────────────────────────────────────────────────

function isDotDomain(domain: string): boolean {
  return domain.endsWith(".dot");
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function parseUrlWithFallbackProtocol(url: string): URL | null {
  return parseUrl(url) ?? parseUrl("https://" + url);
}

function getDotUrlFromParsed(parsed: URL): DotNsUrl | null {
  if (!isDotDomain(parsed.hostname)) {
    return null;
  }
  return {
    identifier: parsed.hostname,
    pathname: parsed.pathname.replace(/^\//, "") + parsed.search + parsed.hash,
  };
}

// ── Localhost ────────────────────────────────────────────────

export interface LocalhostUrl {
  host: string; // e.g. "localhost:5000"
  pathname: string; // e.g. "path?q=1#h=2" (no leading slash)
}

function parseLocalhostUrl(url: string): LocalhostUrl | null {
  const normalized = url.trim();
  if (!normalized) {
    return null;
  }

  const withProtocol = normalized.startsWith("localhost")
    ? "http://" + normalized
    : normalized;

  const parsed = parseUrl(withProtocol);
  if (parsed?.hostname !== "localhost") {
    return null;
  }

  return {
    host: parsed.host,
    pathname: parsed.pathname.replace(/^\//, "") + parsed.search + parsed.hash,
  };
}

// ── Public API ───────────────────────────────────────────────

function parseDotNsDomain(url: string): DotNsUrl | null {
  const normalized = url.trim();
  if (!normalized) {
    return null;
  }

  const parsed = normalized.startsWith("polkadot://")
    ? parseUrl(normalized)
    : parseUrlWithFallbackProtocol(normalized);

  if (!parsed) {
    return null;
  }
  return getDotUrlFromParsed(parsed);
}

/** Ensure a URL has a protocol so it opens as an absolute URL, not a relative path. */
function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return url;
  }
  const parsed = parseUrlWithFallbackProtocol(trimmed);
  return parsed ? parsed.href : url;
}

export const dotNsUrl = {
  isDotDomain,
  parseDotNsDomain,
  parseLocalhostUrl,
  normalizeUrl,
};
