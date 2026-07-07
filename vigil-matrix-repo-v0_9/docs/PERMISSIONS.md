# Permissions

Every permission in `manifest.json`, and why it exists. The guiding rule:
if a permission cannot be justified in one paragraph here, it gets removed.

## `declarativeNetRequest`

The core of the extension. All enforcement — blocking, allowing, cookie and
referrer header stripping, CSP injection, HTTPS upgrades, kill switches —
happens through DNR rules that VIGIL compiles from your matrix. This
permission covers managing dynamic/session rules and enabling/disabling the
bundled static blocklist ruleset.

Note: VIGIL deliberately uses `declarativeNetRequest` (which shows a
"Block content on any page" style warning) rather than
`declarativeNetRequestWithHostAccess`, and does **not** request broad host
permissions — it cannot read responses or inject into pages beyond the
scanner described below.

## `declarativeNetRequestFeedback`

Powers the "matched rules" viewer (`getMatchedRules`) and the action badge
match counter. This is diagnostic only, browser-rate-limited (~20 calls per
10 minutes), and its data never leaves the device. If you build a fork
without the viewer, this permission can be dropped.

## `activeTab` + `scripting`

The page scanner (`src/pageScan.js`) is injected **only when you open the
popup or side panel**, **only into the tab you are looking at** (all frames
of it). It reads resource *URLs* (via the Performance API and DOM element
attributes) to populate matrix rows — never page text or form input.
`activeTab` grants temporary access to the current tab on user gesture;
`scripting` provides the `executeScript` API. VIGIL requests **no** `<all_urls>`
or per-site host permissions.

## `storage`

Policies, switches, settings and observed-domain history live in
`chrome.storage.local`; drafts, temporary trust and rule snapshots live in
`chrome.storage.session`. Nothing uses `chrome.storage.sync`.

## `sidePanel`

Lets the matrix open in Chrome's side panel so it stays visible while the
page reloads. Cosmetic; safe to remove in forks.

## Explicitly absent

- **No `<all_urls>` / host permissions** — VIGIL never reads page content or
  injects into pages you are not actively inspecting.
- **No `webRequest`** — MV3 observation-only `webRequest` would allow
  passive traffic monitoring; VIGIL's model does not need it and its absence
  is a privacy feature.
- **No `cookies`, `history`, `tabs` (beyond activeTab), `downloads`,
  `nativeMessaging`, `identity`.**
