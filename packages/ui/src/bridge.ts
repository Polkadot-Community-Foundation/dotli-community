// dot.li — Host-container bridge
//
// Connects embedded dApps to host services (accounts, signing, chain
// connections, scoped storage) via postMessage protocol.
// Only imported by the host build — keeps smoldot, auth, and verifiable.js
// out of the sandbox bundle.

import { BASE_DOMAIN } from "@dotli/config/config";
import { getBackend, getCacheSettings } from "@dotli/config/mode";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import { buildAllowAttribute } from "./permissions";

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

// Track current product state for permission-grant reloads
let currentRenderMode: "iframe" | "subdomain" | null = null;
let currentLabel: string | null = null;
let currentUrl: string | null = null;
let currentCid: string | null = null;

// Listen for device permission grants — reload the iframe so the
// updated `allow` attribute takes effect.
window.addEventListener("dotli:device-permission-changed", () => {
  if (
    currentRenderMode === "iframe" &&
    currentUrl !== null &&
    currentLabel !== null
  ) {
    void renderIframe(currentUrl, currentLabel);
  } else if (
    currentRenderMode === "subdomain" &&
    currentCid !== null &&
    currentLabel !== null
  ) {
    void renderAppSubdomain(currentCid, currentLabel);
  }
});

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

  currentRenderMode = "iframe";
  currentLabel = label;
  currentUrl = url;
  currentCid = null;

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
  iframe.allow = `${buildAllowAttribute(label)}; cross-origin-isolated`;
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

  window.dispatchEvent(
    new CustomEvent("dotli:product-loaded", { detail: { label } }),
  );
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

  currentRenderMode = "subdomain";
  currentLabel = label;
  currentCid = cid;
  currentUrl = null;

  // Propagate the two independent backend axes. The legacy `?mode=`
  // preset param is no longer sent — host and sandbox deploy together,
  // there are no old sandbox builds in the wild, and the sandbox
  // validator rejects unknown params so keeping it would guarantee a
  // boot failure on the next deploy.
  //
  // The sandbox reads its own curated endpoint defaults from
  // `@dotli/config/endpoints` (same package, built into its bundle), so
  // the host no longer threads RPC/gateway URLs across the origin —
  // there are no user-overridable endpoints to preserve.
  const chainBackend = getBackend();
  const cache = getCacheSettings();
  const appOrigin = getAppOrigin(cid);
  const deepPath = getDeepPath();
  // One-shot: the settings popover sets this flag right before reloading so
  // the first sandbox boot after "Save & Apply" wipes its own origin too.
  // Consume + clear so subsequent navigations (permission reload, etc.)
  // don't keep triggering resets.
  let fullReset = false;
  try {
    if (sessionStorage.getItem("dotli:pending-reset:sandbox") === "1") {
      fullReset = true;
      sessionStorage.removeItem("dotli:pending-reset:sandbox");
    }
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable (Safari private mode); reset flag defaults to false which is the safe state.
  } catch {
    /* sessionStorage unavailable — skip pending reset */
  }
  let url = deepPath ? `${appOrigin}${deepPath}` : appOrigin;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("chainBackend", chainBackend);
    if (cache.skipArchiveCache) {
      parsed.searchParams.set("skipArchiveCache", "1");
    }
    if (fullReset) {
      parsed.searchParams.set("fullReset", "1");
    }
    url = parsed.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    url += `${sep}chainBackend=${chainBackend}`;
    if (cache.skipArchiveCache) {
      url += "&skipArchiveCache=1";
    }
    if (fullReset) {
      url += "&fullReset=1";
    }
  }

  const iframe = document.createElement("iframe");
  iframe.sandbox.add(
    "allow-scripts",
    "allow-same-origin",
    "allow-forms",
    "allow-pointer-lock",
    "allow-popups",
  );
  iframe.allow = buildAllowAttribute(label);
  iframe.style.cssText =
    "position:fixed;top:40px;left:0;width:100%;height:calc(100vh - 40px);border:none;margin:0;padding:0;";
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";

  // Keep the loading overlay visible — the sandbox will post status
  // messages via dotli:loading-status and a final done=true to dismiss it.
  // Only remove non-loading children from #app before appending the iframe.
  const loading = app.querySelector(".loading");
  app.innerHTML = "";
  if (loading) {
    app.appendChild(loading);
  }
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

  window.dispatchEvent(
    new CustomEvent("dotli:product-loaded", { detail: { label } }),
  );
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
