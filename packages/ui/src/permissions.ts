// dot.li — Permission storage
//
// Persists host-level permission decisions per product in localStorage.
// Two categories:
//   - Device permissions (Camera, Microphone, Location, Bluetooth) —
//     gated via iframe `allow` attribute; granting/revoking reloads iframe.
//   - Transaction Submit — gated in signing handlers; revoking reloads iframe
//     so the product restarts in the correct state.
//
// Permission status: 'ask' (default), 'granted', or 'denied'.

export type PermissionStatus = "ask" | "granted" | "denied";

/** Map from Host API device permission names to Permissions Policy directives. */
export const DEVICE_PERMISSION_POLICY: Record<string, string> = {
  Camera: "camera",
  Microphone: "microphone",
  Location: "geolocation",
  Bluetooth: "bluetooth",
};

/** All permissions shown in the topbar menu, in display order. */
export const ALL_PERMISSIONS: readonly {
  name: string;
  label: string;
}[] = [
  { name: "Camera", label: "Camera" },
  { name: "Microphone", label: "Microphone" },
  { name: "Location", label: "Location" },
  { name: "Bluetooth", label: "Bluetooth" },
  { name: "TransactionSubmit", label: "Sign Transactions" },
];

/** Returns true if the permission name maps to an iframe `allow` directive. */
export function isDevicePermission(name: string): boolean {
  return name in DEVICE_PERMISSION_POLICY;
}

// ── Storage helpers ──────────────────────────────────────

const STORAGE_PREFIX = "dotli:permissions:";

type StoredPermissions = Record<string, PermissionStatus>;

function storageKey(label: string): string {
  return STORAGE_PREFIX + label;
}

function readStored(label: string): StoredPermissions {
  try {
    const raw = localStorage.getItem(storageKey(label));
    if (raw === null) {
      return {};
    }
    return JSON.parse(raw) as StoredPermissions;
  } catch {
    return {};
  }
}

function writeStored(label: string, data: StoredPermissions): void {
  localStorage.setItem(storageKey(label), JSON.stringify(data));
}

// ── Public API ───────────────────────────────────────────

export function getPermissionStatus(
  label: string,
  permission: string,
): PermissionStatus {
  return readStored(label)[permission] ?? "ask";
}

export function setPermissionStatus(
  label: string,
  permission: string,
  status: PermissionStatus,
): void {
  const data = readStored(label);
  data[permission] = status;
  writeStored(label, data);
}

export function resetPermission(label: string, permission: string): void {
  const data = readStored(label);
  const { [permission]: _, ...rest } = data;
  writeStored(label, rest);
}

/** Returns the list of device permission names that have been granted. */
export function getGrantedDevicePermissions(label: string): string[] {
  const data = readStored(label);
  return Object.entries(data)
    .filter(
      ([name, status]) => status === "granted" && isDevicePermission(name),
    )
    .map(([name]) => name);
}

/** Returns true if any permission (device or remote) is granted. */
export function hasAnyGrant(label: string): boolean {
  const data = readStored(label);
  return Object.values(data).some((status) => status === "granted");
}

/**
 * Build the iframe `allow` attribute value from granted device permissions.
 * Always includes `clipboard-write`; adds Permissions Policy directives
 * for each granted device permission.
 */
export function buildAllowAttribute(label: string): string {
  const policies = ["clipboard-write"];
  for (const name of getGrantedDevicePermissions(label)) {
    const directive = DEVICE_PERMISSION_POLICY[name] as string | undefined;
    if (directive !== undefined) {
      policies.push(directive);
    }
  }
  return policies.join("; ");
}
