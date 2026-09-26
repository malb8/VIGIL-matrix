export const PROTECTED_PAGE_MESSAGE = "VIGIL is unavailable on this page because Chromium does not allow extensions to inspect or modify protected browser pages.";

const PROTECTED_SCHEMES = new Set([
  "about:", "brave:", "chrome:", "chrome-extension:", "chrome-search:",
  "chrome-untrusted:", "devtools:", "edge:", "opera:", "vivaldi:"
]);

export function isProtectedBrowserPage(url) {
  try {
    const parsed = new URL(url);
    if (PROTECTED_SCHEMES.has(parsed.protocol)) return true;
    if (parsed.hostname === "chromewebstore.google.com") return true;
    return parsed.hostname === "chrome.google.com" && parsed.pathname.startsWith("/webstore");
  } catch (_) {
    return false;
  }
}

export function popupLoadErrorMessage(error, pageUrl = "") {
  const message = String(error?.message || error);
  const galleryInjectionDenied = /extensions? gallery\b.*\bcannot be scripted\b/i.test(message);
  return isProtectedBrowserPage(pageUrl) || galleryInjectionDenied
    ? PROTECTED_PAGE_MESSAGE
    : message;
}
