# Changelog

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
- Codebase audit: zero references to any AI assistant/vendor in the source
  (verified by grep); developer comments expanded throughout the new modules.

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
