// dot.li — MIME type detection
//
// Shared between archive.ts (main thread) and sw.ts (Service Worker).

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
  if (lastDot === -1) {
    return "application/octet-stream";
  }
  const ext = path.substring(lastDot + 1).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}
