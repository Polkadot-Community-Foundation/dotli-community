// dot.li — Error serialization helper
//
// Turn an unknown thrown/rejected value into a non-empty string suitable
// for transmission over wire formats (protocol envelopes, JSON-RPC errors)
// and display in logs / Sentry.
//
// This helper guarantees a non-empty return value and preserves as much
// context as possible: error name, AggregateError branches, and a shallow
// `.cause` summary.

/**
 * Serialize an unknown value (typically from a `catch` or Promise rejection)
 * into a non-empty, human-readable string.
 *
 * Always returns a non-empty string. Prefers `Error.message`, falls back to
 * `Error.name`, then "Unknown error".
 */
export function serializeError(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "string") {
    return value.length > 0 ? value : "Unknown error";
  }

  if (value instanceof Error) {
    let result = value.message || value.name || "Unknown error";

    // AggregateError / any Error with an `errors` array: include up to 3
    // underlying messages so group-failures stay debuggable.
    const errors = (value as Error & { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const inner = errors.slice(0, 3).map(describeShallow).join("; ");
      const suffix = errors.length > 3 ? ", ..." : "";
      result += ` [${inner}${suffix}]`;
    }

    // `.cause` (ES2022) — walk one level only to avoid cycles.
    const cause = (value as Error & { cause?: unknown }).cause;
    if (cause !== undefined) {
      result += ` (cause: ${describeShallow(cause)})`;
    }

    return result;
  }

  if (typeof value === "object") {
    // Prefer a string `.message` field when present (DOMException-like objects
    // without the Error prototype, SDK errors from libraries that forget to
    // `extends Error`, etc.).
    const obj = value as { message?: unknown };
    if (typeof obj.message === "string" && obj.message.length > 0) {
      return obj.message;
    }
    // Last resort: JSON, falling back to the default toString.
    try {
      const json = JSON.stringify(value);
      if (json && json !== "{}" && json !== "null") {
        return json;
      }
    } catch {
      // circular or non-serializable value — fall through
    }
    return "[object Object]";
  }

  // number, boolean, bigint, symbol, function — narrow each primitive
  // explicitly so the no-base-to-string lint rule is satisfied.
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "function") {
    return value.name || "anonymous function";
  }
  return "Unknown error";
}

/**
 * Single-level description used when recursing into `.cause` / `errors`.
 * Does not recurse — prevents infinite loops on cyclic cause chains.
 */
function describeShallow(value: unknown): string {
  if (value instanceof Error) {
    return value.message || value.name || "Unknown error";
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return value.length > 0 ? value : "Unknown error";
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "function") {
    return value.name || "anonymous function";
  }
  return "Unknown error";
}
