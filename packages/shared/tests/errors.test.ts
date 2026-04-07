import { describe, it, expect } from "vitest";
import { serializeError } from "@dotli/shared/errors";

describe("serializeError", () => {
  // ── primitives ────────────────────────────────────────────────
  it("returns 'null' for null", () => {
    expect(serializeError(null)).toBe("null");
  });

  it("returns 'undefined' for undefined", () => {
    expect(serializeError(undefined)).toBe("undefined");
  });

  it("returns non-empty string as-is", () => {
    expect(serializeError("boom")).toBe("boom");
  });

  it("returns 'Unknown error' for empty string", () => {
    expect(serializeError("")).toBe("Unknown error");
  });

  it("stringifies numbers and booleans", () => {
    expect(serializeError(42)).toBe("42");
    expect(serializeError(false)).toBe("false");
  });

  // ── Error instances ───────────────────────────────────────────
  it("extracts message from Error", () => {
    expect(serializeError(new Error("kaboom"))).toBe("kaboom");
  });

  it("falls back to Error.name when message is empty (DOTLI-1K)", () => {
    const err = new Error("");
    expect(serializeError(err)).toBe("Error");
  });

  it("falls back to Error.name for TypeError with no message", () => {
    const err = new TypeError("");
    expect(serializeError(err)).toBe("TypeError");
  });

  it("preserves named subclasses with empty messages", () => {
    class AlreadyDestroyedError extends Error {
      override name = "AlreadyDestroyedError";
    }
    expect(serializeError(new AlreadyDestroyedError(""))).toBe(
      "AlreadyDestroyedError",
    );
  });

  it("handles an Error whose message is a real value", () => {
    const err = new RangeError("out of range");
    expect(serializeError(err)).toBe("out of range");
  });

  // ── .cause (ES2022) ───────────────────────────────────────────
  it("appends a shallow cause description", () => {
    const inner = new Error("inner boom");
    const outer = new Error("outer boom", { cause: inner });
    expect(serializeError(outer)).toBe("outer boom (cause: inner boom)");
  });

  it("handles a non-Error cause", () => {
    const outer = new Error("outer boom", { cause: "string cause" });
    expect(serializeError(outer)).toBe("outer boom (cause: string cause)");
  });

  it("does not infinitely recurse on a cyclic cause chain", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    // .cause only walks one level, so no stack overflow.
    const out = serializeError(a);
    expect(out).toContain("a");
    expect(out).toContain("cause: b");
  });

  // ── AggregateError ────────────────────────────────────────────
  it("includes inner errors from AggregateError", () => {
    const agg = new AggregateError(
      [new Error("first"), new Error("second")],
      "all failed",
    );
    expect(serializeError(agg)).toBe("all failed [first; second]");
  });

  it("caps AggregateError to 3 inner errors", () => {
    const agg = new AggregateError(
      [
        new Error("a"),
        new Error("b"),
        new Error("c"),
        new Error("d"),
        new Error("e"),
      ],
      "many failed",
    );
    expect(serializeError(agg)).toBe("many failed [a; b; c, ...]");
  });

  // ── plain objects ─────────────────────────────────────────────
  it("extracts .message from a plain object", () => {
    expect(serializeError({ message: "plain object error" })).toBe(
      "plain object error",
    );
  });

  it("ignores empty .message on plain objects and falls back to JSON", () => {
    expect(serializeError({ message: "", code: 42 })).toBe(
      '{"message":"","code":42}',
    );
  });

  it("JSON-serializes plain objects without a message field", () => {
    expect(serializeError({ code: -32603 })).toBe('{"code":-32603}');
  });

  it("returns '[object Object]' for empty objects", () => {
    expect(serializeError({})).toBe("[object Object]");
  });

  it("tolerates circular objects", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    // Should not throw; should return a non-empty fallback.
    expect(serializeError(cyclic)).toBe("[object Object]");
  });

  // ── invariant ─────────────────────────────────────────────────
  it("never returns an empty string", () => {
    const inputs: unknown[] = [
      null,
      undefined,
      "",
      0,
      false,
      {},
      [],
      new Error(""),
      new Error(),
      { message: "" },
    ];
    for (const value of inputs) {
      const out = serializeError(value);
      expect(out.length).toBeGreaterThan(0);
    }
  });
});
