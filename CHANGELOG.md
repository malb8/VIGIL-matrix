# Changelog

## 0.13.2 — 2026-08-28

### Added
- **CNAME-cloaking naming heuristic.** A same-site subdomain (e.g.
  `analytics.example.com`) whose own label matches a curated list of
  tracking-infrastructure naming patterns (`trackingHostHints` in
  `data/domain-classification.json`) is now flagged in the matrix as a
  possible first-party-disguised tracker, with distinct amber "verify
  before blocking" styling — separate from the existing red "known
  tracker" suggestion, since this is a naming guess, not a verdict. The
  existing (previously unused) `coreHostHints` list now doubles as a
  suppressor: a subdomain chain containing an ordinary infra label (`api`,
  `cdn`, `www`, etc.) is never flagged even if another label in the chain
  also matches a tracking hint. This cannot detect actual CNAME cloaking —
  that requires resolving the CNAME chain, an API Chromium extensions have
  no access to at all (unlike Firefox's `browser.dns.resolve()`, which is
  how uBlock Origin does it there) — so it is a local pattern nudge to go
  verify a specific host, not a real detector. Deliberately excluded from
  "Apply suggested blocks": false positives here are costlier than for a
  known external tracker domain, so the decision stays manual.

## 0.13.1 — 2026-08-28

### Fixed
- **Popup matrix no longer leaks other sites' policy targets.** The matrix's
  domain list was pulling policy-target rows from every scope the extension
  had ever stored a site policy for (i.e. every site you've configured, not
  just the current one), because the background state hands the popup the
  full cross-site `sitePolicies` store and the matrix builder iterated all of
  it unconditionally. A domain blocked on one site could show up as a row on
  an unrelated site's matrix even though it never appeared in that site's
  traffic. The matrix now only pulls policy targets from scopes in the
  current page's actual chain (global + this registrable domain +
  subdomains).

### Added
- **"Only observed" toggle** in the popup toolbar: filters the matrix down to
  rows that were actually seen in the current page's live scan, hiding
  history- and policy-only rows (e.g. a global rule for a domain that simply
  didn't load on this page) on demand. Off by default; state resets each time
  the popup opens.
- **New per-scope switch: `strip-tracking-params`.** Redirects navigations to
  drop known click/campaign query params (`utm_*`, `fbclid`, `gclid`,
  `msclkid`, etc. — see `TRACKING_PARAMS` in `src/lib/dnrCompiler.js`) via
  DNR's `redirect.transform.queryTransform`. Scoped to `main_frame`/
  `sub_frame` only, never subresource requests, since query params on
  script/XHR calls are often functionally significant. Its priority sits
  just below `https-upgrade` on purpose: both are redirect-family DNR
  actions and only one can win per request, so an http:// link with tracking
  params gets upgraded first (params intact on that one internal hop); the
  resulting https:// request no longer matches the upgrade rule, so
  tracking-param stripping fires on that second pass instead. Net effect is
  correct either way.
- **CSP hash allowlist for `no-inline-script`.** That switch blocks *all*
  inline `<script>` execution, which is often too blunt for real sites. You
  can now allowlist specific known-good inline scripts by their exact
  `'sha256-...'`/`'sha384-...'`/`'sha512-...'` content hash (Chrome's own
  console error for a blocked inline script prints the hash to use), scoped
  per-site like the switch itself. Nonces are intentionally not supported:
  they're meant to rotate every page load, but this compiles into a static
  DNR header-append rule that can't read the response body to learn the
  current nonce, so only a stable content hash is actually usable here.
  Editable from a small chip list under the switches bar once
  `no-inline-script` is on for the current scope.

## 0.12.0 — 2026-08-03

### UI
- **Popup layout overhaul: no more two-axis scrolling.** The matrix section
  is now the single scroll container in the popup/side panel; everything
  above it (header, summary, scope bar, switches, legend, toolbars) is fixed
  chrome that never scrolls away.
  - **Vertical scrolling** stays local to the matrix: the header row (the
    `"*"` row with its cell buttons) is `position: sticky; top: 0` inside
    that one container, so it stays visible while rows scroll underneath.
  - **Horizontal scrolling is eliminated in the common case.** Cells shrank
    to a 16px visual square (from 22px) with a fixed `table-layout` and a
    `<colgroup>` that gives the domain column an explicit width and lets the
    9 resource columns split the rest equally — the whole grid now fits
    inside Chrome's 800px popup cap without a horizontal scrollbar for a
    typical 9-column matrix. If a hostname is still wider than the domain
    column, the first column itself is `position: sticky; left: 0` (with the
    corner cell sticky on both axes) so it never disappears mid-scroll.
  - Domain names truncate with an ellipsis (full name still in the tooltip);
    indented hostname sub-rows truncate from the **left** instead (a
    `direction: rtl` trick) so the distinguishing part next to the ⤷ arrow
    doesn't get crowded out by a long shared suffix.
  - All sticky cells (header, first column, corner) get opaque, row-matched
    backgrounds — the table now zebra-stripes each row (including host sub-
    rows, which keep their own shade) so a sticky cell's background is
    identical to the rest of its row and nothing "ghosts" through it while
    scrolling.
- **Cell compaction.** Visual cells are 16px, but the clickable `<button>`
  around each one keeps a ~22px padded hit target (padding on the button,
  not the colored square) so clicking stays comfortable and the buttons
  remain keyboard-focusable with a visible focus ring. The header `"*"` row
  and the "All" column use the exact same cell size as the body so columns
  stay aligned.
  - **Density encoding replaces in-cell text.** A cell for a `(target,
    type)` pair with no observed traffic now renders its state (block /
    allow / inherited / suggestion) at ~55% opacity instead of full
    intensity — no numbers are drawn inside cells at this size. Exact counts
    remain in the existing tooltip.
  - The pending/dirty ring stayed a solid 2px amber outline, kept visually
    distinct from the diagonal-stripe suggestion tints at the smaller size.
- **Density pass on rows.** The per-domain meta line ("third-party · 190
  observed · 3 hosts") moved into the row's tooltip; only the observed count
  survives on-row, as a small pill badge next to the domain name. Row
  padding shrank so noticeably more rows fit in the 600px popup height.
- **Legend collapsed behind a "?" toggle chip** that expands it as an
  overlay on demand instead of permanently consuming a row; the open/closed
  state is remembered for the session (`sessionStorage`, not
  `storage.local`).
- **Side panel is the scale escape hatch.** The popup's 800×600 cap is
  claimed explicitly (body renders at the full budget instead of
  auto-sizing narrower); in the side panel (detected via
  `chrome.extension.getViews`, since both surfaces load the same
  `popup.html`) that cap is dropped — width 100%, matrix fills the available
  height. When the popup's matrix exceeds 25 rows, a small hint appears
  above it ("Large matrix? Open in side panel") linking the existing
  side-panel action.
- No behavior change: cell cycling, expanders, switches, scope bar, and the
  matched-rules viewer are unchanged.

## 0.11.0 — 2026-07-13

### Features
- **Three-way default mode** replaces the boolean default-deny.
  `settings.defaultMode` is `open` (default — nothing blocked unless you say
  so), `relaxed`, or `hard`:
  - **relaxed** blocks only high-risk *third-party* subresources — scripts,
    XHR/fetch/websocket/beacon, frames and plugin objects — using DNR's own
    `domainType: thirdParty`, and strips third-party cookies (a `modifyHeaders`
    rule at priority 299, below every authored cookie cell so your explicit
    cookie rules stay authoritative). First-party requests and third-party
    images/CSS/fonts/media keep loading; top navigation is never touched.
  - **hard** is the former default-deny (block every subresource type).

  Explicit allow cells (priority ≥ 10) override every mode, unchanged.
- Options page now has an **Open / Relaxed / Hard** radio (was a default-deny
  checkbox); the popup shows a one-line **Mode:** status above the matrix, and
  unruled cells preview the mode's effect (a default block shows as inherited;
  a default allow stays noop).
- "My rules" text gains `setting: default-mode open|relaxed|hard`.
  `setting: default-deny on|off` still parses as a legacy alias (`on` → hard,
  `off` → open).

### Security
- **CSP hardening fix**: the `no-inline-script` switch no longer lists
  `data:`/`blob:` in the injected `script-src`. Those schemes re-opened the
  exact pseudo-inline injection the switch exists to close — an attacker with a
  markup/attribute-injection primitive could run
  `<script src="data:text/javascript,…">`, which CSP matches against the source
  list rather than treating as inline, so it sailed through a policy that only
  omits `'unsafe-inline'`. `CSP_NO_INLINE_VALUE` is now `script-src 'unsafe-eval' *`
  — `*` covers network-scheme sources but, per CSP, not `data:`/`blob:`.

### Model & internals
- `resolveOutcome` and the draft neutralizers are mode-aware via a new
  `defaultOutcomeFor` (hard → block; relaxed → block only for a third-party
  high-risk type; open → allow), approximating first-vs-third-party by
  registrable domain so the popup preview matches compiled behavior.
- `schemaVersion` bumped to 8: `defaultDeny: true` migrates to
  `defaultMode: "hard"`, `false`/absent to `"open"`; the legacy key is dropped
  on load. Imports accept schema 1–8 and still read an old export's
  `defaultDeny`.
- New evaluator coverage in `test/compiler.test.mjs`: `domainType` matching,
  relaxed block/allow/cookie behavior, per-mode neutralizer fallback,
  rules-text round-trip incl. the legacy alias, and the CSP regression.

## 0.10.0 — 2026-07-09

### Fixes
- **D2 fail-open**: nested hostname scopes/targets (e.g. `a.b.example.com`
  under `b.example.com`) used to collapse to the same capped specificity
  level and emit an identical DNR priority; Chrome's equal-priority tiebreak
  (allow wins) then decided instead of depth, so a deliberate, more specific
  block could be silently overridden by a shallower allow. `scopeLevel` and
  `targetSpecificity` now encode real label depth below the registrable
  domain (capped at `MAX_NESTING_DEPTH = 6` — deep enough that no legitimate
  hostname reaches it), so nested cells resolve by actual specificity via the
  priority number itself, the same way every other coordinate does.
  Verified against real Chromium DNR (`getDynamicRules()`), not just the
  mini evaluator: a shallow allow and a deeper block on the same target now
  compile to strictly ordered priorities (80 vs 112) and the deeper rule
  wins.

### Model & internals
- Priority ladder re-laid to fit the widened scope/target range: matrix
  cells 10–265, cookie stripping 300–427, strip-referrer 450–452,
  https-upgrade 460–462, CSP no-inline/no-worker 470–478, matrix-off 500,
  trust-site 510. See ARCHITECTURE.md's "Priority ladder" section.
- New `findSpecificityConflicts`: the one residual case depth can't order —
  two committed cells that both exceed the depth cap, are in a real
  ancestor/descendant relationship, and disagree on action — is now rejected
  at the write boundary (`commitSitePolicy`, `commitGlobalPolicy`,
  `importState`, `applyRulesText`) with a descriptive error, surfaced
  through the existing popup/options error banner, rather than silently
  resolved by Chrome's tiebreak. Verified end-to-end in a real browser: the
  exact conflict message reaches the options page's status line and the
  write never lands in `chrome.storage.local`.
  The gate deliberately does **not** live inside `compileCommittedRules`
  itself, since that also runs unconditionally on every browser startup —
  a throwing compiler there would mean a conflict already present in stored
  policy leaves a user with zero enforcement until they happen to re-save it.
- Switches keep a separate, unwidened `switchScopeTier` (global / apex /
  deeper) instead of the new depth-aware `scopeLevel`: they are independent
  per-scope toggles, not competing cells, and reusing the widened function
  would have collided CSP no-inline's scope bump with CSP no-worker's base.
- `schemaVersion` 7: no stored-data shape change — marks that specificity
  now resolves by real depth; schema-6 policy data recompiles under the new
  rules with no migration needed. Imports accept schema 1–7.

### Tests
- Suite grown to 44 tests: nested-scope and nested-target precedence proven
  in both directions (deeper block beats shallower allow, and vice versa) via
  the mini DNR evaluator; `findSpecificityConflicts` behavior matrix (flags
  genuine beyond-cap ancestor conflicts, correctly ignores same-depth
  siblings, agreeing actions, and disjoint types); D3 (draft shadowing) and
  D5 (cookie band above every allow) regressions re-verified at the new,
  wider priority range.

### Known limitations (unchanged or documented)
- Removing a committed cookie block via a draft applies only after Save.
- Two disagreeing, ancestor-related cells that both exceed
  `MAX_NESTING_DEPTH` are rejected at save time rather than resolved
  automatically — see "Specificity conflicts" in ARCHITECTURE.md. No real
  hostname nests this deep in practice.
- No live per-cell request counters under MV3.

## 0.9.0 — 2026-07-07

### New capabilities
- **Hostname hierarchy** (point 1): rows group per registrable domain with
  collapsible hostname sub-rows; cells may target a full hostname, which
  overrides the domain-level cell. Scope keys may likewise be hostnames.
  Implemented by encoding cell coordinates (scope level x target specificity
  x type specificity x draft layer) directly into DNR priorities (10–57).
- **Bulk toggles + the `*` row** (point 2): the header row *is* the `*` row —
  column headers cycle the ("*", type) cell, and every row gained a leading
  "All" cell for its (target, "*") coordinate. Specific cells override both.
- **CSP switches** (point 4): per-scope *no-inline-script* and *no-worker*
  toggles inject `Content-Security-Policy` headers (modifyHeaders append) on
  the scope's documents and embedded frames. Priorities 170–176.
- **Strip referrer & HTTPS upgrade** (point 5): per-scope switches; referrer
  stripping via modifyHeaders (site scopes exclude main_frame), HTTPS upgrade
  via native `upgradeScheme` on `|http://` (site scope compiles a
  main_frame + subresource rule pair). Priorities 150–162.
- **Static blocklists** (point 6): bundled static ruleset (disabled by
  default, options toggle, re-asserted at bootstrap) + `tools/build-blocklist.mjs`
  to compile any hosts-format list. Priority 5, below every matrix cell, so
  explicit allows override the list; main_frame excluded. Static rules do not
  consume dynamic quota.
- **Persistent kill switch** (point 7): *Matrix off* switch = committed
  `allowAllRequests` at priority 300 (temporary trust-site stays at 310).
- **"My rules" text editor** (point 8): full committed policy as plain text
  (`<scope> <target> <type> <action>`, `switch:`, `setting:` lines) with
  load / line-diff preview / apply in options, parse errors reported per line.
  Pure module `src/lib/rulesText.js`, round-trip covered by tests.

### Model & internals
- New coordinate-based priority ladder (see ARCHITECTURE.md): draft layer adds
  +1 while distinct coordinates differ by ≥2, so drafts shadow their own cell
  but never outrank more specific cells.
- Draft-removal neutralizers are now computed with the shared
  `resolveOutcome` resolver over the merged (draft-overlaid) view and respect
  default-deny (a removed block stays blocked in hard mode until saved
  otherwise). The popup uses the same resolver for inherited cell previews.
- `SET_SWITCH`, `SET_BLOCKLIST`, `APPLY_RULES_TEXT` messages; `SET_SETTINGS`
  now recompiles session rules too (neutralizers depend on defaultDeny).
- Schema version 6: `switches` store, `settings.blocklistEnabled`, hostname
  scope/target keys, `*` targets/types; imports accept schema 1–6.
- Observed history now keeps up to 12 raw hostnames per target to feed the
  hostname rows; the popup persists several hosts per (target, type).
- Rule snapshots record touched header names so the matched-rules viewer can
  distinguish cookie stripping, referrer stripping and CSP injection.

### Tests
- Suite grown to 38 tests; the mini DNR evaluator now models `upgradeScheme`,
  `|http://` scheme matching, Chrome's tie-break order and header-rule
  suppression. New coverage: hostname target/scope precedence, `*` row/column
  semantics, main_frame exclusion, default-deny neutralizers, all five
  switches, blocklist-vs-allow interplay, resolveOutcome chains, rules-text
  round-trip/diff/error reporting.

### Known limitations (unchanged or documented)
- Removing a committed cookie block via a draft applies only after Save.
- Nested hostname scopes/targets beyond the modeled depth share a priority
  level (DNR tie-break applies).
- No live per-cell request counters under MV3.

## 0.8.0 — 2026-07-07

All findings from the v0.4 review, fixed in one pass.

### New capabilities
- **Default-deny mode** (options): priority-1 block-all dynamic rule; allow
  cells punch through. (finding #2)
- **Cookie column**: per-target `Cookie`/`Set-Cookie` stripping via
  `modifyHeaders`, site & global scope, priorities 80–95 placed above all allow
  priorities so an allow cell can't accidentally re-enable cookies. Site scope
  excludes `main_frame`. Cookie cells are block-only. (finding #4)
- **Observed-domain history**: blocked domains no longer vanish from the matrix.
  Per-site history in `storage.local` (200 sites / 80 targets / 30-day TTL) plus
  policy-referenced targets are merged into the rows, labeled *history only* /
  *policy only*. (finding #1)
- **Trust site (temp)**: session `allowAllRequests` rule at priority 200.
- **Side panel** support (`sidePanel` permission, Chrome ≥ 121). (finding #15)
- **Quota display** with ≥80% warning against
  `MAX_NUMBER_OF_DYNAMIC_RULES` / `MAX_NUMBER_OF_SESSION_RULES`.

### Correctness fixes
- XHR column now compiles to `xmlhttprequest + websocket + ping + other`; media
  to `media + object`; scanner maps `beacon`/`ping`/`object`/`embed`. (finding #3)
- Scanner runs `allFrames: true` and merges frame results. (finding #8)
- Weak `initiatorType`s (`css`, `link`, `other`) defer to file-extension
  heuristics — CSS-loaded fonts are now classified as fonts. (finding #5)
- **Promise-queue mutex** around all background message handling; no more
  interleaved `updateDynamicRules` read-modify-write races. (finding #6)
- **Timestamped rule snapshots** (last 6 per store) so `getMatchedRules`
  attribution survives recompiles that renumber IDs; API quota surfaced.
  (findings #7, #12)
- PSL-lite extended with **private suffixes** (`github.io`, `pages.dev`,
  `netlify.app`, `vercel.app`, `s3.amazonaws.com`, `blogspot.com`, …) and more
  ccSLDs; 3-label suffixes checked before 2-label. Fixes different tenants being
  treated as same-site. (finding #13)
- IDN domains are **punycoded on import** instead of rejected. (finding #14)
- `options.js` handlers all `.catch(showError)`; JSON parse errors surfaced.
  (finding #9)
- Dead `storage.session` fallback removed; MV3 guarantees availability.
  (finding #10)
- **Rule compaction** (merge resource types, then targets) before install;
  typically 60–80% fewer rules. ID-exhaustion guard per partition. (finding #11)
- Bootstrap (incl. `setExtensionActionOptions`) now also on `onStartup`; icons
  16/32/48/128 shipped; `incognito: "spanning"` declared. (finding #16)

### Engineering
- Compiler extracted to a **pure ES module** (`src/lib/dnrCompiler.js`) +
  `src/lib/domains.js`.
- **Test suite** (`node --test`, 20 tests) with a miniature DNR evaluator
  replicating Chrome's priority semantics. (finding #17)
- Background service worker converted to an ES module; schemaVersion 5
  (imports accept 1–5).

### Known limitations
- Removing a *committed* cookie block via a draft only takes effect after Save
  (a `modifyHeaders` rule can't be neutralized by a session allow at the layer
  the drafts use — it must be removed from the dynamic store).
- PSL-lite is a curated subset, not the full Public Suffix List.
- `getMatchedRules` quota (~20 calls / 10 min) limits how often per-rule match
  info can refresh; the UI degrades gracefully with a note.

## 0.4.0
- Initial MVP: draft/committed model over session/dynamic DNR rules, site &
  global scopes, policy packs, import/export, page scanner (top frame).
