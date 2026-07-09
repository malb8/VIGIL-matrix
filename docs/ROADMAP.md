# Roadmap

Status: v0.10 (experimental research preview). Items are intentions, not
promises; ordering reflects current priority.

## v1.0 — publication hardening
- Repository governance complete (this docs set) and CI running the node
  test suite: done.
- Reproducible release zip: done — `distro/vigil-matrix-store-v0_10.zip`
  (manifest.json + src/ + data/ + icons/ only, no docs/tests/tools) is a
  single package submittable to both the Chrome Web Store and Edge
  Add-ons, since both accept the same MV3 unpacked-extension zip.
  Rebuild the same way (stage manifest.json, src/, data/, icons/ at the
  zip root, nothing else) for each future version.
- Tagged releases: partial — `v0.9.0` is tagged; `v0.10.0` is not yet
  (the D2 fail-open fix landed on `main` but hasn't been tagged).
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
- Release package: done (see above). Permission justifications
  (docs/PERMISSIONS.md) and screenshots/promo tiles
  (`store-assets/`, gitignored — kept out of the public repo on purpose)
  already exist locally.
- Still open: create the actual Chrome Web Store and Edge Add-ons
  developer-account listings, host PRIVACY.md at a public URL for the
  listing's privacy-policy field, write the single-purpose statement, and
  submit `vigil-matrix-store-v0_10.zip` to both. Feature-gate anything
  unpacked-only (dev-mode live counters, once built) before submitting.
- Edge Add-ons can be submitted in parallel with CWS now — the same
  package works for both, so there's no dependency between the two
  submissions beyond wanting consistent listing copy.

## Explicit non-goals
- Full uMatrix compatibility (MV3 cannot express all of it).
- A complete request logger (no blocking `webRequest` in MV3).
- Remote list fetching / auto-update of rules at runtime.
- Element hiding / cosmetic filtering (different problem; other tools do it
  well).
- Any form of telemetry, including "anonymous usage statistics".
