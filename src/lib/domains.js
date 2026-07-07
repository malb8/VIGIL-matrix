/*
 * VIGIL Matrix Lite - shared domain normalization (v0.8)
 *
 * Pure module. No chrome.* usage, importable from the service worker,
 * extension pages and the node test suite.
 */

export function canonicalHost(host) {
  return String(host || "").toLowerCase().replace(/^\.+|\.+$/g, "");
}

/*
 * PSL-lite registrable-domain resolution.
 *
 * `suffixes` is a Set of public/private suffixes with 2 or 3 labels
 * (e.g. "co.uk", "github.io", "s3.amazonaws.com"). Longer suffixes are
 * checked first so "s3.amazonaws.com" wins over a hypothetical "amazonaws.com".
 */
export function registrableDomain(host, suffixes) {
  const h = canonicalHost(host);
  const parts = h.split(".").filter(Boolean);
  if (parts.length <= 2) return h;

  const set = suffixes instanceof Set ? suffixes : new Set(suffixes || []);
  const lastTwo = parts.slice(-2).join(".");
  const lastThree = parts.slice(-3).join(".");

  if (set.has(lastThree) && parts.length >= 4) return parts.slice(-4).join(".");
  if (set.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join(".");
  return lastTwo;
}

/*
 * Convert a possibly-IDN domain to its ASCII (punycode) form.
 * Uses the URL parser, which applies IDNA/ToASCII and lowercasing.
 * Throws on unparseable input.
 */
export function toAsciiDomain(domain) {
  const raw = String(domain || "").trim();
  if (!raw) throw new Error("Empty domain");
  // URL requires a scheme; the host portion is what we want back.
  const url = new URL(`http://${raw}`);
  if (url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Not a bare domain: ${domain}`);
  }
  return url.hostname.replace(/\.$/, "");
}

export function isValidAsciiDomain(domain) {
  if (!domain || typeof domain !== "string") return false;
  if (!/^[a-z0-9.-]+$/i.test(domain)) return false;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;
  return true;
}
