#!/usr/bin/env bun
//
// Unified preview server for perf tests.
// Routes by hostname to serve all builds from a single port:
//   host.localhost:PORT   →  dist/protocol/
//   *.app.localhost:PORT  →  dist/app/
//   *.localhost:PORT      →  dist/host/
//
// This mirrors production nginx routing where host.dot.li, *.app.dot.li,
// and *.dot.li are served from separate builds.

import { existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const PORT = parseInt(process.env.PORT ?? "5173", 10);
const ROOT = join(import.meta.dir, "..");
// Monorepo layout: apps/host/dist/, apps/sandbox/dist/, apps/protocol/dist/
const HOST_DIR = join(ROOT, "apps/host/dist");
const APP_DIR = join(ROOT, "apps/sandbox/dist");
const PROTOCOL_DIR = join(ROOT, "apps/protocol/dist");

// Verify builds exist — warn for optional builds, exit for required ones
const REQUIRED_BUILDS = ["Host", "App (sandbox)"] as const;
for (const [label, dir] of [
  ["Host", HOST_DIR],
  ["App (sandbox)", APP_DIR],
  ["Protocol", PROTOCOL_DIR],
] as const) {
  if (!existsSync(dir)) {
    const isRequired = (REQUIRED_BUILDS as readonly string[]).includes(label);
    if (isRequired) {
      console.error(
        `${label} build not found at ${dir}\nRun: bun run build (from monorepo root)`,
      );
      process.exit(1);
    }
    console.warn(
      `⚠ ${label} build not found at ${dir} — requests to this origin will 404`,
    );
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".webm": "video/webm",
  ".txt": "text/plain",
  ".scale": "application/octet-stream",
  ".map": "application/json",
};

function serveFile(filePath: string): Response | null {
  try {
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) return null;
  } catch {
    return null;
  }
  const mime = MIME[extname(filePath)] ?? "application/octet-stream";
  return new Response(Bun.file(filePath), {
    headers: {
      "Content-Type": mime,
      "Service-Worker-Allowed": "/",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    },
  });
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch(req) {
    const url = new URL(req.url);
    const isProtocol = url.hostname === "host.localhost";
    const isApp = url.hostname.includes(".app.");
    const baseDir = isProtocol ? PROTOCOL_DIR : isApp ? APP_DIR : HOST_DIR;
    const fallback = "index.html";

    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = `/${fallback}`;

    // Try exact file
    const exact = join(baseDir, pathname);
    const res = serveFile(exact);
    if (res) return res;

    // Try directory index
    const res2 = serveFile(join(exact, "index.html"));
    if (res2) return res2;

    // SPA fallback
    return (
      serveFile(join(baseDir, fallback)) ??
      new Response("Not Found", { status: 404 })
    );
  },
});

console.log(`Preview server on http://localhost:${PORT}`);
console.log(`  Host: ${HOST_DIR}`);
console.log(`  App:  ${APP_DIR}`);
console.log(`  Protocol: ${PROTOCOL_DIR}`);
