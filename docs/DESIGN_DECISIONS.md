# Design Decisions

A record of the choices that shaped VIGIL Matrix, so future contributors do
not have to re-litigate them blind. Format: decision → why → trade-off.

## D1 — DNR-only enforcement, no `webRequest`
MV3 removed blocking `webRequest`; observation-only `webRequest` would allow
passive monitoring of all traffic. VIGIL compiles policy into DNR rules and
asks for no host permissions.
**Trade-off:** no live request log or per-cell counters; diagnostics are
reconstructed from `getMatchedRules` (quota-limited) plus page scans.

## D2 — Priorities encode cell coordinates
uMatrix's "most specific cell wins" is reproduced by encoding
(scope level, target specificity, type specificity, draft layer) into the
rule priority: `10 + s*16 + t*4 + y*2 + layer`. Chrome's own evaluator then
*is* the precedence engine — no runtime resolution code that could disagree
with enforcement.
**Trade-off:** limited depth (3 scope levels, target specificity capped at
3); nested hostname scopes at the same level fall back to DNR tie-breaking.

## D3 — Draft layer as +1 in the same ladder
Drafts (session rules) sit exactly one priority above their committed
coordinate, and coordinates are ≥2 apart. A draft therefore shadows its own
cell but can never defeat a more specific committed cell — which is what
"try this change" should mean.
**Trade-off:** draft *removals* need synthesized neutralizer rules whose
action comes from `resolveOutcome` over the merged view; cookie cells cannot
be neutralized (see D5).

## D4 — One resolver for compiler and UI
`resolveOutcome` (scope chain × target chain × type chain, highest priority
wins) is exported by the compiler and reused by the popup for inherited-cell
previews. What you see is literally what compiles.

## D5 — Cookie stripping above every allow
Chrome suppresses a `modifyHeaders` rule when an allow of equal/higher
priority matches. Cookie rules therefore occupy a band (80–103) above all
matrix priorities, so allowing a script can never silently re-enable its
cookies.
**Trade-off:** a draft cannot neutralize a committed cookie block (an allow
above the cookie band would suppress unrelated header rules); removal
applies after Save. Documented in the UI tooltip.

## D6 — Switches commit immediately (no draft layer)
matrix-off, CSP switches, referrer stripping and HTTPS upgrade are per-scope
*toggles* in fixed bands above the cookie band. Modeling them as draftable
cells would double their complexity for no real workflow gain.

## D7 — `main_frame` is sacred
Type-`*` cells, default-deny and the blocklist never match `main_frame`:
a policy tool must not make pages unreachable by navigation. Site-scoped
cookie/referrer rules also skip `main_frame` because a navigation's
initiator is the *previous* page.

## D8 — Blocklist as a static ruleset at priority 5
Static rulesets do not consume the 30k dynamic quota and ship inside the
package (no remote lists). Priority 5 < matrix base 10 means an explicit
allow cell always beats the list — curated lists advise, the user decides.

## D9 — PSL-lite instead of the full Public Suffix List
The full PSL is ~250 KB and changes over time; VIGIL bundles a curated
subset (common ccTLD second levels + popular private suffixes) used for
grouping and specificity math.
**Trade-off:** exotic suffixes may group as the wrong registrable domain.
Swappable by editing `data/domain-classification.json`.

## D10 — Observed-domain history
MV3 page scans cannot see requests DNR already blocked, so successfully
blocked domains would vanish from the matrix and become un-unblockable.
Scans persist per site (capped, TTL) purely to keep rows visible.
**Trade-off:** local storage of hostnames seen per site — documented in
PRIVACY.md, capped, and deletable.

## D11 — Zero dependencies, no build step
The repo root is the extension; pure modules are tested with `node:test`.
Reviewability is the security feature: everything a reviewer needs fits in
a few files with no generated code.

## D12 — Text rules as the canonical exchange format
`<scope> <target> <type> <action>` lines are diffable, reviewable and
version-controllable; the serializer is canonical (sorted) so two equal
policies always produce identical text. JSON export remains for full-state
backup.
