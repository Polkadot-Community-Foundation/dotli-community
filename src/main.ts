// dot.li — Universal Viewer entry point
//
// Flow: parse URL → resolve .dot name via smoldot → fetch content from Bulletin → render in iframe

import { resolveDotName, destroyClient } from "./resolve";
import { fetchContent, destroyHelia } from "./fetch";
import { renderContent, showStatus, showError, showLanding } from "./render";

/**
 * Extract the .dot label from the current hostname.
 *
 * Examples:
 *   "myapp.dot.li"        → "myapp"
 *   "myapp.localhost"      → "myapp"    (local dev)
 *   "dot.li"              → null        (landing page)
 *   "localhost"            → null        (landing page)
 */
function parseDotLabel(): string | null {
  const hostname = window.location.hostname;

  // Production: name.dot.li
  if (hostname.endsWith(".dot.li")) {
    const label = hostname.slice(0, -".dot.li".length);
    return label || null;
  }

  // Local dev: name.localhost
  if (hostname.endsWith(".localhost")) {
    const label = hostname.slice(0, -".localhost".length);
    return label || null;
  }

  return null;
}

async function main(): Promise<void> {
  const label = parseDotLabel();

  if (!label) {
    showLanding();
    return;
  }

  showStatus(`Resolving ${label}.dot...`);

  try {
    // Step 1: Resolve the .dot name to a CID via smoldot + dotNS
    const cid = await resolveDotName(label, showStatus);

    if (!cid) {
      showError(
        `${label}.dot`,
        "This domain has no content set. The owner needs to publish content to the Bulletin Chain and set the content hash.",
      );
      return;
    }

    // Step 2: Fetch the content from Bulletin Chain
    const content = await fetchContent(cid, showStatus);

    // Step 3: Render in sandboxed iframe
    showStatus("Rendering...");
    renderContent(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showError("Resolution failed", message);
  }
}

// Cleanup on page unload
window.addEventListener("beforeunload", () => {
  destroyClient();
  destroyHelia();
});

main();
