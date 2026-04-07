import { isDevicePermission } from "./permissions";

// dot.li — Permission request modal (vanilla DOM)
//
// Shows a confirmation dialog when a product requests a permission
// (Camera, Microphone, Location, Bluetooth, or TransactionSubmit).
// Returns a Promise that resolves on "Allow" and rejects on "Deny".
//
// DOM structure follows the signing modal pattern (signing.css).

const PERMISSION_LABELS: Record<string, string> = {
  Camera: "Camera",
  Microphone: "Microphone",
  Location: "Location",
  Bluetooth: "Bluetooth",
  TransactionSubmit: "Sign Transactions",
};

const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  Camera: "Access your camera for photo and video capture",
  Microphone: "Access your microphone for audio input",
  Location: "Access your location for geolocation services",
  Bluetooth: "Connect to nearby Bluetooth devices",
  TransactionSubmit: "Sign and submit on-chain transactions on your behalf",
};

const PERMISSION_ICONS: Record<string, string> = {
  Camera:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>' +
    '<circle cx="12" cy="13" r="4"/></svg>',
  Microphone:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>' +
    '<path d="M19 10v2a7 7 0 0 1-14 0v-2"/>' +
    '<line x1="12" y1="19" x2="12" y2="23"/>' +
    '<line x1="8" y1="23" x2="16" y2="23"/></svg>',
  Location:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>' +
    '<circle cx="12" cy="10" r="3"/></svg>',
  Bluetooth:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/></svg>',
  TransactionSubmit:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/>' +
    '<polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
};

/**
 * Show a permission request modal. Resolves when the user clicks "Allow",
 * rejects when the user clicks "Deny".
 */
export function showPermissionRequestModal(
  label: string,
  permission: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const backdrop = document.createElement("div");
    backdrop.className = "signing-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "signing-modal";

    // Icon
    const iconWrap = document.createElement("div");
    iconWrap.className = "permission-modal-icon";
    iconWrap.innerHTML = PERMISSION_ICONS[permission] ?? "";
    modal.appendChild(iconWrap);

    // Heading
    const heading = document.createElement("h2");
    heading.textContent = "Permission Request";
    modal.appendChild(heading);

    // Description
    const desc = document.createElement("div");
    desc.className = "signing-fields";

    const productField = document.createElement("div");
    productField.className = "signing-field";

    const productLabel = document.createElement("div");
    productLabel.className = "signing-field-label";
    productLabel.textContent = "Application";
    productField.appendChild(productLabel);

    const productValue = document.createElement("div");
    productValue.className = "signing-field-value";
    productValue.textContent = `${label}.dot`;
    productField.appendChild(productValue);

    desc.appendChild(productField);

    const permField = document.createElement("div");
    permField.className = "signing-field";

    const permLabel = document.createElement("div");
    permLabel.className = "signing-field-label";
    permLabel.textContent = "Permission";
    permField.appendChild(permLabel);

    const permValue = document.createElement("div");
    permValue.className = "signing-field-value";
    permValue.textContent =
      PERMISSION_DESCRIPTIONS[permission] ??
      `Access to ${PERMISSION_LABELS[permission] ?? permission}`;
    permField.appendChild(permValue);

    desc.appendChild(permField);

    if (isDevicePermission(permission)) {
      const notice = document.createElement("div");
      notice.className = "permission-modal-notice";
      notice.textContent =
        "Granting this permission will reload the application.";
      desc.appendChild(notice);
    }

    modal.appendChild(desc);

    // Footer
    const footer = document.createElement("div");
    footer.className = "signing-modal-footer";

    const denyBtn = document.createElement("button");
    denyBtn.className = "signing-btn-cancel";
    denyBtn.textContent = "Deny";
    footer.appendChild(denyBtn);

    const allowBtn = document.createElement("button");
    allowBtn.className = "signing-btn-sign";
    allowBtn.textContent = "Allow";
    footer.appendChild(allowBtn);

    modal.appendChild(footer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    function cleanup(): void {
      backdrop.remove();
    }

    denyBtn.addEventListener("click", () => {
      cleanup();
      reject(new Error("User denied permission"));
    });

    allowBtn.addEventListener("click", () => {
      cleanup();
      resolve();
    });

    // Close on backdrop click (outside modal)
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) {
        cleanup();
        reject(new Error("User dismissed permission dialog"));
      }
    });
  });
}
