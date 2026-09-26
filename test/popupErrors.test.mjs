import test from "node:test";
import assert from "node:assert/strict";
import {
  popupLoadErrorMessage,
  PROTECTED_PAGE_MESSAGE
} from "../src/lib/popupErrors.js";

test("protected Chromium pages render the protected-page explanation", () => {
  const error = new Error("Cannot access a chrome:// URL");
  assert.equal(popupLoadErrorMessage(error, "chrome://settings/privacy"), PROTECTED_PAGE_MESSAGE);
});

test("Chrome Web Store injection denial renders the protected-page explanation", () => {
  const error = new Error("The extensions gallery cannot be scripted.");
  assert.equal(
    popupLoadErrorMessage(error, "https://chrome.google.com/webstore/devconsole/example"),
    PROTECTED_PAGE_MESSAGE
  );
});

test("unrelated scripting errors remain unchanged", () => {
  const message = "Page scan returned no results. Reload the page and retry.";
  assert.equal(
    popupLoadErrorMessage(new Error(message), "https://example.com/"),
    message
  );
});
