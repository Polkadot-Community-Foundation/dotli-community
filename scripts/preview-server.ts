#!/usr/bin/env bun
//
// Unified preview server for perf tests.
// Routes by hostname to serve both host and app builds from a single port:
//   *.app.localhost:PORT  →  dist/app/   (app-main.ts build)
//   *.localhost:PORT      →  dist/host/  (main.ts build)
//
// This mirrors production nginx routing where *.app.dot.li and *.dot.li
// are served from separate builds.

import { existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const PORT = parseInt(process.env.PORT ?? "5173", 10);
const ROOT = join(import.meta.dir, "..");
// Monorepo layout: apps/host/dist/ and apps/sandbox/dist/
const HOST_DIR = join(ROOT, "apps/host/dist");
const APP_DIR = join(ROOT, "apps/sandbox/dist");

// Verify builds exist
for (const [label, dir] of [
  ["Host", HOST_DIR],
  ["App (sandbox)", APP_DIR],
] as const) {
  if (!existsSync(dir)) {
    console.error(
      `${label} build not found at ${dir}\nRun: bun run build (from monorepo root)`,
    );
    process.exit(1);
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
    const isApp = url.hostname.includes(".app.");
    const baseDir = isApp ? APP_DIR : HOST_DIR;
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
