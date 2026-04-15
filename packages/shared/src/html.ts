/**
 * Escape a string for safe interpolation into innerHTML.
 * Covers the four HTML-significant characters: & < > "
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Validate a .dot label: lowercase alphanumeric + interior hyphens, 1–63 chars.
 * Matches DNS label rules and the dotNS naming spec.
 */
const DOT_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export function isValidDotLabel(label: string): boolean {
  return DOT_LABEL_RE.test(label);
}
