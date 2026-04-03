// dot.li — Host-container bridge
//
// Connects embedded dApps to host services (accounts, signing, chain
// connections, scoped storage) via postMessage protocol.
// Only imported by the host build — keeps smoldot, auth, and verifiable.js
// out of the sandbox bundle.

import { BASE_DOMAIN } from "@dotli/config/config";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";

// Re-export sandbox-safe rendering functions
export { renderContent, renderArchive, prepareIframe } from "./render";

// Eagerly load the container bridge chunk — starts downloading when
// this module is imported, so it's ready by the time we need it.
const chunkLoadStart = performance.now();
const containerChunkPromise = import("./container").then((mod) => {
  m.measure(S.BRIDGE_CHUNK_LOAD, performance.now() - chunkLoadStart);
  return mod;
});
void containerChunkPromise.catch(() => {
  /* fire-and-forget */
});

const app = document.getElementById("app") ?? document.body;

let currentDispose: (() => void) | null = null;
let currentPanelDispose: (() => void) | null = null;

/**
 * Capture deep link path (pathname + search + hash) to forward into the iframe.
 */
function getDeepPath(): string {
  const { pathname, search, hash } = window.location;
  let p = pathname;
  const base = import.meta.env.BASE_URL;
  if (base !== "/" && p.startsWith(base)) {
    p = "/" + p.slice(base.length);
  }
  const stripped = p.replace(/^\/[^/]+\.dot/, "");
  const isRoot = stripped === "" || stripped === "/";
  if (isRoot) {
    return search || hash ? search + hash : "";
  }
  return stripped + search + hash;
}

/**
 * Render an iframe with the host-container bridge.
 *
 * Unlike the base renderIframe, this sets up the postMessage bridge
 * between the host and the embedded dApp, enabling accounts, signing,
 * chain connections, and scoped storage.
 */
export async function renderIframe(url: string, label: string): Promise<void> {
  const stopSetup = m.timer(S.BRIDGE_SETUP);
  cleanup();

  const hasTopbar = document.getElementById("topbar") !== null;
  const iframeStyle = hasTopbar
    ? "position:fixed;top:40px;left:0;width:100%;height:calc(100vh - 40px);border:none;margin:0;padding:0;"
    : "position:fixed;top:0;left:0;width:100%;height:100vh;border:none;margin:0;padding:0;";

  app.innerHTML = "";
  const iframe = document.createElement("iframe");
  // TODO: Review sandbox default permissions
  iframe.sandbox.add(
    "allow-scripts",
    "allow-same-origin",
    "allow-forms",
    "allow-pointer-lock",
  );
  iframe.allow = "clipboard-write";
  iframe.style.cssText = iframeStyle;
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
  app.appendChild(iframe);

  const { setupContainer, setupNestedBridgeDetector } =
    await containerChunkPromise;
  const disposePrimary = setupContainer(iframe, url, label);
  const disposeNested = setupNestedBridgeDetector(iframe, label);
  currentDispose = () => {
    disposePrimary();
    disposeNested();
  };

  if (
    (import.meta.env.VITE_SANDBOX_CHECKER as string | undefined) !== undefined
  ) {
    const { setupViolationPanel } =
      await import("@dotli/sandbox-checker/sandbox-checker-ui");
    currentPanelDispose = setupViolationPanel(iframe);
  }

  stopSetup();
  document.title = `${label} — dot.li`;
}

/**
 * Render content in a cross-origin app subdomain iframe (cid.app.dot.li).
 * Used by the host build to delegate content fetching+rendering to the app context.
 *
 * Sets up the container bridge targeting the app iframe. The app context
 * acts as a transparent postMessage relay between the host and the dApp iframe.
 */
export async function renderAppSubdomain(
  cid: string,
  label: string,
): Promise<void> {
  const stopSetup = m.timer(S.BRIDGE_SETUP);
  cleanup();

  const appOrigin = getAppOrigin(cid);
  const deepPath = getDeepPath();
  const url = deepPath ? `${appOrigin}${deepPath}` : appOrigin;

  const iframe = document.createElement("iframe");
  iframe.sandbox.add(
    "allow-scripts",
    "allow-same-origin",
    "allow-forms",
    "allow-pointer-lock",
    "allow-popups",
  );
  iframe.allow = "clipboard-write";
  iframe.style.cssText =
    "position:fixed;top:40px;left:0;width:100%;height:calc(100vh - 40px);border:none;margin:0;padding:0;";
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
  app.innerHTML = "";
  app.appendChild(iframe);

  const { setupContainer, setupNestedBridgeDetector } =
    await containerChunkPromise;
  const disposePrimary = setupContainer(iframe, url, label);
  const disposeNested = setupNestedBridgeDetector(iframe, label);
  currentDispose = () => {
    disposePrimary();
    disposeNested();
  };

  if (
    (import.meta.env.VITE_SANDBOX_CHECKER as string | undefined) !== undefined
  ) {
    const { setupViolationPanel } =
      await import("@dotli/sandbox-checker/sandbox-checker-ui");
    currentPanelDispose = setupViolationPanel(iframe);
  }

  stopSetup();
  document.title = `${label}.dot`;
}

function getAppOrigin(cid: string): string {
  const hostname = window.location.hostname;
  if (hostname.endsWith(".localhost") || hostname === "localhost") {
    const port = import.meta.env.DEV ? "5174" : window.location.port;
    return `http://${cid}.app.localhost:${port}`;
  }
  return `https://${cid}.app.${BASE_DOMAIN}`;
}

function cleanup(): void {
  if (currentPanelDispose) {
    currentPanelDispose();
    currentPanelDispose = null;
  }
  if (currentDispose) {
    currentDispose();
    currentDispose = null;
  }
}
