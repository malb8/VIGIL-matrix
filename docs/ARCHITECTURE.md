# Architecture

## Modules

| File | Role |
| --- | --- |
| `src/lib/dnrCompiler.js` | Pure compiler: policies + switches → DNR rules. Also exports `resolveOutcome`, the inheritance resolver shared by the session neutralizers and the popup's cell preview. No `chrome.*`. |
| `src/lib/rulesText.js` | Pure "My rules" text format: parse / serialize / canonical lines / diff. No `chrome.*`. |
| `src/lib/domains.js` | Canonical host, PSL-lite registrable domain, IDN→punycode. |
| `src/background.js` | Service worker: state, storage, message dispatch (serialized), compile-and-apply, snapshots, history, blocklist toggling. |
| `src/pageScan.js` | Classic script injected into every frame; classifies observed resources per raw hostname. |
| `src/popup.js` / `popup.html` / `popup.css` | Matrix UI: 3 scopes, hostname hierarchy, `*` header row, All column, switch chips, matched-rules viewer. |
| `src/options.js` / `options.html` | Default-deny + blocklist toggles, My-rules editor with diff, JSON import/export. |
| `tools/build-blocklist.mjs` | hosts-format → static DNR ruleset JSON. |
| `data/static-blocklist.json` | Bundled static ruleset (disabled by default). |
| `test/compiler.test.mjs` | Node test suite with a miniature DNR evaluator. |

## Rule stores

| Store | Contents | IDs |
| --- | --- | --- |
| static (`blocklist`) | bundled blocklist, toggled via `updateEnabledRulesets` | 1+ |
| dynamic | committed matrix cells, default-deny, switches, matrix-off | 100000–199999 |
| session | draft cells, neutralizers, trust-site | 200000–299999 |

## Priority ladder (the heart of v0.9)

A matrix cell has a **coordinate** (scope level `s`, target specificity `t`,
type specificity `y`, layer). The coordinate is encoded in the rule priority so
Chrome's "highest priority wins" reproduces "most specific cell wins":

```
matrix priority = 10 + s*16 + t*4 + y*2 + layer        (10..57)
cookie priority = 80 + s*8  + t*2 + layer              (80..103)

s: 0 global "*"  | 1 registrable-domain scope | 2 hostname scope
t: 0 target "*"  | 1 registrable domain | 2 subdomain | 3 deeper (capped)
y: 0 type "*"    | 1 specific type
layer: 0 committed (dynamic) | 1 draft (session)
```

The minimum gap between two *different* coordinates is 2 while the draft layer
adds only 1, so a draft shadows its own committed cell but never outranks a
more specific cell. Scope dominates target dominates type, matching uMatrix.

Fixed bands above and below:

| Priority | Rule |
| --- | --- |
| 1 | default-deny block-all (subresource types only) |
| 5 | static blocklist (any allow cell ≥10 overrides it) |
| 10–57 | matrix cells (see formula) |
| 80–103 | cookie stripping (`modifyHeaders`) — above every allow so an allow can never suppress it |
| 150–152 | strip-referrer (+ scope level) |
| 160–162 | https-upgrade (`upgradeScheme`) |
| 170–172 / 174–176 | CSP no-inline-script / no-worker (`modifyHeaders` append) |
| 300 | matrix-off (`allowAllRequests`, dynamic, persistent) |
| 310 | trust-site (`allowAllRequests`, session, temporary) |

`allowAllRequests` suppresses every lower-priority rule in the frame tree,
including the `modifyHeaders` bands — which is exactly what a kill switch and
temporary trust should do.

## Compiler pipeline

1. **Collect cells** from `{ "*": globalPolicy, ...sitePolicies }` (scope keys
   may be hostnames). Each cell gets its coordinate priority.
2. **Compact**: two-pass merge — union resource types per (scope, kind,
   priority, target), then merge `requestDomains` per identical type set.
   Because the priority encodes the coordinate, different specificities can
   never merge.
3. **Emit**: `requestDomains` omitted for target `*`; type `*` expands to all
   subresource types (never `main_frame`); `initiatorDomains: [scope]` for
   site scopes; cookie cells become `modifyHeaders` remove rules.
4. **Switch rules** are appended (global: unconditioned; site: split into
   `requestDomains` rules for the scope's own documents and
   `initiatorDomains` rules for what it initiates).

## Draft semantics & neutralizers

The session store overlays the dynamic store. For every (target, type) pair in
an edited scope:

- draft block/allow ≠ committed → session rule at `layer 1` (shadows the
  committed cell; identical values are skipped, the dynamic rule suffices);
- draft **noop over a committed value** (a removal) → a **neutralizer** at the
  removed cell's coordinate whose action is whatever `resolveOutcome` finds in
  the strictly less specific *merged* layers — falling back to block under
  default-deny, allow otherwise. More specific cells keep winning because
  their coordinates carry higher priorities.

Cookie cells cannot be neutralized (an allow above the cookie band would
suppress unrelated header rules), so removing a committed cookie block only
takes effect after Save. The popup tooltip says so.

`resolveOutcome` walks scope chain × target chain × {type, `*`} and returns the
highest-priority non-noop cell. The popup uses the *same function* over a
merged view (drafts overlaid, working policy substituted) for its inherited
cell preview, so what you see is what compiles.

## Switches

Stored in `chrome.storage.local.switches[scope]`, committed immediately via
`SET_SWITCH` (no draft layer). CSP switches append headers on `main_frame` /
`sub_frame` documents of the scope; strip-referrer excludes `main_frame` in
site scopes (a navigation's initiator is the previous page); https-upgrade uses
`urlFilter "|http://"`.

## Static blocklist

Declared in the manifest (`rule_resources`, id `blocklist`, disabled). Options
toggles it with `updateEnabledRulesets`; the desired state persists in
settings and is re-asserted at bootstrap. `tools/build-blocklist.mjs` converts
hosts-format lists into chunked `requestDomains` block rules at priority 5.
Chrome guarantees 30k enabled static rules (larger shared pool available), so
sizable lists fit without touching the dynamic quota.

## Concurrency & attribution

- All message handlers run through a serialized promise queue — no interleaved
  `updateDynamicRules`/`updateSessionRules` read-modify-write cycles.
- Every compile stores a timestamped snapshot (last 6 per store) including the
  touched header names; `GET_MATCHED_RULES` resolves matches against the
  snapshot live at the match timestamp, so renumbered rules stay attributable.
  `getMatchedRules` is browser-quota-limited (~20 calls / 10 min).

## Scanning & history

`pageScan.js` runs in every frame (classic script), classifies via initiator
type with file-extension override for weak initiators, and reports per raw
hostname. The popup aggregates per registrable domain *and* keeps the raw-host
breakdown for hostname rows; scans persist per site (200 sites, 80 targets,
12 raw hosts per target, 30-day TTL) so blocked hosts remain visible.

## State & migrations

`schemaVersion 6`: adds `switches` (local) and `settings.blocklistEnabled`;
site policy keys may now be hostnames and targets may be `*`/hostnames, types
may be `*`. Imports accept schema 1–6; IDN keys are punycoded. Drafts live in
`storage.session` (survive SW restarts, not browser restarts).

## Known limitations

- Cookie draft-removal applies only after Save (see above).
- Two *nested hostname scopes* (e.g. `a.b.example.com` and `b.example.com`)
  both map to scope level 2; if they ever disagree on the same coordinate, DNR
  tie-breaking (allow wins) decides instead of depth. Same for targets deeper
  than two labels below the registrable domain (spec capped at 3).
- PSL-lite is a bundled subset, not the full Public Suffix List.
- No live per-cell request counters: MV3 offers no unlimited match feedback
  (`onRuleMatchedDebug` is unpacked-only; `getMatchedRules` is quota-limited).
