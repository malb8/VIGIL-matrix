# Roadmap

Status: v0.10 (experimental research preview). Items are intentions, not
promises; ordering reflects current priority.

## v1.0 — publication hardening
- Repository governance complete (this docs set), tagged releases,
  reproducible release zip, CI running the node test suite.
- Manual test pass across popular site categories (news, banking, SPA,
  video) in default and default-deny mode; fixups from that pass.
- Accessibility pass on the popup (keyboard navigation of matrix cells,
  ARIA labels on cell buttons).
- Localization scaffold (popup strings via `chrome.i18n`), starting with
  English and Dutch.

## v1.x — candidate features
- **Dev-mode live counters**: `onRuleMatchedDebug` works for unpacked
  extensions; offer opt-in per-cell match counters in dev installs, clearly
  labeled as unavailable in store builds.
- **Full Public Suffix List option**: optional bundled full PSL (larger
  package) replacing PSL-lite; user-selectable in options.
- **Blocklist manager**: multiple static rulesets (ads / trackers / custom),
  per-list toggles, list metadata + attribution surfaced in options.
- **Policy packs 2.0**: shareable rules-text snippets with diff-preview
  install (the "My rules" pipeline already supports it).
- **Ruleset health panel**: per-band rule counts, compaction ratio, nearest
  quota, orphaned-policy detector (rules for domains never seen).
- **CNAME hint heuristics**: flag first-party subdomains whose observed
  behavior matches known tracker patterns (local heuristics only).

## Store release track (parallel, unscheduled)
- Chrome Web Store listing: privacy-policy URL (PRIVACY.md), permission
  justifications (docs/PERMISSIONS.md), screenshots, single-purpose
  statement. Feature-gate anything unpacked-only.
- Edge Add-ons after CWS, given policy overlap.

## Explicit non-goals
- Full uMatrix compatibility (MV3 cannot express all of it).
- A complete request logger (no blocking `webRequest` in MV3).
- Remote list fetching / auto-update of rules at runtime.
- Element hiding / cosmetic filtering (different problem; other tools do it
  well).
- Any form of telemetry, including "anonymous usage statistics".
