import { describe, it, expect } from "vitest";
import {
  parseSettingsFromSearch,
  writeSettingsToSearch,
} from "@dotli/config/url-settings";
import { NetworkName } from "@dotli/config/network";

describe("parseSettingsFromSearch", () => {
  it("returns nulls for absent or invalid values", () => {
    const empty = parseSettingsFromSearch(new URLSearchParams());
    expect(empty).toEqual({
      network: null,
      chainBackend: null,
      skipArchiveCache: null,
      skipCidCache: null,
      skipWorkerCache: null,
    });

    const invalid = parseSettingsFromSearch(
      new URLSearchParams("network=bogus&chainBackend=nope&skipCidCache=true"),
    );
    expect(invalid.network).toBeNull();
    expect(invalid.chainBackend).toBeNull();
    expect(invalid.skipCidCache).toBeNull();
  });

  it("returns the typed value for each valid axis", () => {
    const parsed = parseSettingsFromSearch(
      new URLSearchParams(
        "network=paseo-next-v2&chainBackend=rpc-gateway&skipArchiveCache=0&skipCidCache=1&skipWorkerCache=1",
      ),
    );
    expect(parsed.network).toBe(NetworkName.PASEO_NEXT_V2);
    expect(parsed.chainBackend).toBe("rpc-gateway");
    expect(parsed.skipArchiveCache).toBe(false);
    expect(parsed.skipCidCache).toBe(true);
    expect(parsed.skipWorkerCache).toBe(true);
  });
});

describe("writeSettingsToSearch", () => {
  it("drops default-valued axes and preserves unrelated params", () => {
    const search = new URLSearchParams(
      "network=paseo-next-v2&chainBackend=rpc-gateway&skipArchiveCache=1&keep=me",
    );
    const changed = writeSettingsToSearch(
      {
        network: NetworkName.PASEO_NEXT_V1,
        chainBackend: "smoldot-direct",
        cache: {
          skipCidCache: false,
          skipArchiveCache: false,
          skipWorkerCache: true,
        },
      },
      search,
    );
    expect(changed).toBe(true);
    expect(search.get("network")).toBeNull();
    expect(search.get("chainBackend")).toBeNull();
    expect(search.get("skipArchiveCache")).toBeNull();
    expect(search.get("keep")).toBe("me");
  });

  it("keeps non-default axes with explicit boolean encoding", () => {
    const search = new URLSearchParams();
    writeSettingsToSearch(
      {
        network: NetworkName.PASEO_NEXT_V2,
        chainBackend: "smoldot-direct",
        cache: {
          skipCidCache: true,
          skipArchiveCache: false,
          skipWorkerCache: true,
        },
      },
      search,
    );
    expect(search.get("network")).toBe(NetworkName.PASEO_NEXT_V2);
    expect(search.get("chainBackend")).toBeNull();
    expect(search.get("skipCidCache")).toBe("1");
    expect(search.get("skipArchiveCache")).toBeNull();
    expect(search.get("skipWorkerCache")).toBeNull();
  });
});
