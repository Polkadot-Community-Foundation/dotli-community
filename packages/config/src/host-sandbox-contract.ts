// dot.li — Host → sandbox URL contract
//
// The sandbox runs on `cid.app.<root>` and cannot read the host's
// localStorage (different origin). The host MUST thread every user
// decision through URL params on the iframe load, and the sandbox MUST
// reject any envelope that doesn't match this schema. A silent default
// on the sandbox side would re-introduce the "user picked X, got Y"
// regression class that the determinism audit eliminated.
//
// Schema v1 (current):
//
//   Required:
//     ?chainBackend=<"smoldot-direct" | "smoldot-shared-worker" | "rpc-gateway">
//
//   Optional:
//     ?skipArchiveCache=<"0" | "1">
//     ?fullReset=<"0" | "1">
//     ?v=<schema version integer — reserved for future breakage>
//
// When we add a new required param, bump SANDBOX_SCHEMA_VERSION and
// have the validator reject unmatched versions so stale host builds
// don't feed malformed params to fresh sandbox deploys.

export const SANDBOX_SCHEMA_VERSION = 1;

/** Known chain backends. The only values the sandbox accepts. */
const VALID_CHAIN_BACKENDS: ReadonlySet<string> = new Set([
  "smoldot-direct",
  "smoldot-shared-worker",
  "rpc-gateway",
]);

const VALID_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["0", "1"]);

/** Every param name the sandbox recognises. Anything else is rejected. */
const KNOWN_PARAMS: ReadonlySet<string> = new Set([
  "chainBackend",
  "skipArchiveCache",
  "fullReset",
  "v",
]);

export interface SandboxParams {
  chainBackend: "smoldot-direct" | "smoldot-shared-worker" | "rpc-gateway";
  skipArchiveCache: boolean;
  fullReset: boolean;
}

export type SandboxParamsResult =
  | { ok: true; params: SandboxParams }
  | { ok: false; reason: string };

/**
 * Validate a sandbox URL against the host → sandbox contract.
 *
 * Returns a discriminated result. The caller is expected to render the
 * failure reason in the UI and stop; never substitute defaults silently.
 */
export function validateSandboxParams(
  search: URLSearchParams,
): SandboxParamsResult {
  // Reject unknown params before anything else so a host typo surfaces
  // immediately instead of silently being ignored.
  for (const key of search.keys()) {
    if (!KNOWN_PARAMS.has(key)) {
      return {
        ok: false,
        reason: `Unknown URL param "${key}" (sandbox contract v${String(SANDBOX_SCHEMA_VERSION)}). Reload from the host to pick up the matching build.`,
      };
    }
  }

  // Version gate: if the host sends an explicit version token, it must
  // match. Absent `?v=` means "pre-versioned host", a path now rejected
  // post-collapse because the `?backend=` requirement is also new and a
  // pre-collapse host would not emit it.
  const version = search.get("v");
  if (version !== null && version !== String(SANDBOX_SCHEMA_VERSION)) {
    return {
      ok: false,
      reason: `Sandbox contract version mismatch (got v=${version}, expected v=${String(SANDBOX_SCHEMA_VERSION)}). Reload from the host to pick up the matching build.`,
    };
  }

  const chainBackend = search.get("chainBackend");
  if (chainBackend === null) {
    return {
      ok: false,
      reason:
        "Missing required URL param `chainBackend`. The host did not specify a backend — reload from dot.li.",
    };
  }
  if (!VALID_CHAIN_BACKENDS.has(chainBackend)) {
    return {
      ok: false,
      reason: `Unknown chainBackend "${chainBackend}". Expected "smoldot-direct", "smoldot-shared-worker", or "rpc-gateway".`,
    };
  }

  const skipRaw = search.get("skipArchiveCache");
  if (skipRaw !== null && !VALID_BOOLEAN_FLAGS.has(skipRaw)) {
    return {
      ok: false,
      reason: `Invalid skipArchiveCache "${skipRaw}" — expected "0" or "1".`,
    };
  }

  const resetRaw = search.get("fullReset");
  if (resetRaw !== null && !VALID_BOOLEAN_FLAGS.has(resetRaw)) {
    return {
      ok: false,
      reason: `Invalid fullReset "${resetRaw}" — expected "0" or "1".`,
    };
  }

  return {
    ok: true,
    params: {
      chainBackend: chainBackend as
        | "smoldot-direct"
        | "smoldot-shared-worker"
        | "rpc-gateway",
      skipArchiveCache: skipRaw === "1",
      fullReset: resetRaw === "1",
    },
  };
}
