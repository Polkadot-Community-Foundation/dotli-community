import { describe, it, expect, beforeEach } from "vitest";
import { getRecentLabels, addRecentLabel } from "@dotli/storage/cid-cache";

// cid-cache uses localStorage for recent labels — happy-dom provides it

describe("getRecentLabels", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns empty array when nothing stored", () => {
    expect(getRecentLabels()).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    localStorage.setItem("dotli_recent", "");
    expect(getRecentLabels()).toEqual([]);
  });

  it("returns stored labels", () => {
    localStorage.setItem("dotli_recent", '["myapp","test"]');
    expect(getRecentLabels()).toEqual(["myapp", "test"]);
  });

  it("limits to MAX_RECENT (8) entries", () => {
    const labels = Array.from({ length: 20 }, (_, i) => `label${i}`);
    localStorage.setItem("dotli_recent", JSON.stringify(labels));
    expect(getRecentLabels()).toHaveLength(8);
  });

  it("returns empty array for malformed JSON", () => {
    localStorage.setItem("dotli_recent", "not-json");
    expect(getRecentLabels()).toEqual([]);
  });

  it("returns empty array for non-array JSON", () => {
    localStorage.setItem("dotli_recent", '{"foo":"bar"}');
    expect(getRecentLabels()).toEqual([]);
  });
});

describe("addRecentLabel", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("adds a label to empty list", async () => {
    await addRecentLabel("myapp");
    expect(getRecentLabels()).toEqual(["myapp"]);
  });

  it("prepends new label to front", async () => {
    localStorage.setItem("dotli_recent", '["old"]');
    await addRecentLabel("new");
    expect(getRecentLabels()).toEqual(["new", "old"]);
  });

  it("deduplicates existing label (moves to front)", async () => {
    localStorage.setItem("dotli_recent", '["a","b","c"]');
    await addRecentLabel("b");
    expect(getRecentLabels()).toEqual(["b", "a", "c"]);
  });

  it("limits to MAX_RECENT entries", async () => {
    const initial = Array.from({ length: 8 }, (_, i) => `label${i}`);
    localStorage.setItem("dotli_recent", JSON.stringify(initial));
    await addRecentLabel("new");
    const result = getRecentLabels();
    expect(result).toHaveLength(8);
    expect(result[0]).toBe("new");
    // Last item from initial should be evicted
    expect(result).not.toContain("label7");
  });

  it("returns a resolved promise", async () => {
    const result = addRecentLabel("test");
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });
});
