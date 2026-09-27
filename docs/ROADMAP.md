# Roadmap

Status: v0.15.1 in development (experimental research preview). v0.15.0 is
in review at both Chrome Web Store and Edge Add-ons. Items are intentions,
not promises; ordering reflects current priority.

## v0.15.0 — focused popup and release hardening

### Completed for v0.15.0

- Show nonzero current-scan resource counts in resource-type cells, with
  accessible count labels. All and Cookie remain without counts. The maintainer
  confirmed the layout; counts are observations, not enforcement outcomes.

- Make cell explanations focus-driven: mouse hover no longer opens or updates
  the inspector; keyboard focus, Escape/blur handling and normal cell clicks
  remain unchanged.

- Replace the raw script-injection error on protected browser pages (including
  the Chrome Web Store) with a concise explanation that VIGIL is unavailable
  there because Chromium forbids extension scripting on those pages. Manual
  browser check confirmed by the maintainer.
- Complete the focused popup keyboard check; the maintainer confirmed that
  keyboard operation works in the popup.

- Prepare v0.15.0 version references, changelog, release notes and a verified
  store zip containing only `manifest.json`, `src/`, `data/` and `icons/`.

### Outstanding release checks

- Complete a manual regression pass on representative news, banking, SPA and
  video sites in Open, Relaxed and Hard modes.
- Complete the remaining popup accessibility checks: ARIA labels and
  screen-reader output.
- Complete the store-submission checklist. Existing
  installs must retain their selected mode, blocklist setting and policies.

### v0.15.0 constraints

- No new permissions, telemetry, remote code or remotely fetched lists.
- No resolver, compiler or priority-ladder redesign.
- No full request logger or claim of complete network observability under MV3.

## Store release track

- v0.15.0 is submitted and in review at both Edge Add-ons and Chrome Web Store,
  as confirmed by the maintainer.
- Keep store copy and screenshots aligned between Chrome Web Store and Edge
  Add-ons. Both stores use the same MV3 package.

## v0.15.1 — observed resource viewer (unreleased)

- Add a read-only "View observed resources" dialog with hostname/type filters,
  observed counts, detection sources and retained URL samples.
- Use existing scan data; disclose the three-sample and 240-character limits.
  No response bodies, additional permissions or changes to policy enforcement.
- The maintainer has reviewed and accepted the viewer layout.
- This viewer is not included in the v0.15.0 packages currently in store review.

## After v0.15 — candidate features

- **Dev-mode live counters**: use `onRuleMatchedDebug` in unpacked installs,
  clearly labeled as unavailable in store builds.
- **Full Public Suffix List option**: offer an optional bundled full PSL in
  place of PSL-lite.
- **Blocklist manager**: support multiple static rulesets with per-list
  toggles, metadata and attribution.
- **Policy packs 2.0**: install shareable rules-text snippets with a diff
  preview through the existing My rules pipeline.
- **Ruleset health panel**: show per-band rule counts, compaction ratio,
  nearest quota and orphaned policies.
- **CNAME hint heuristics**: flag first-party subdomains whose observed
  behavior resembles known tracker patterns, using local heuristics only.

## Explicit non-goals

- Full uMatrix compatibility (MV3 cannot express all of it).
- A complete request logger (no blocking `webRequest` in MV3).
- Remote list fetching or runtime auto-updates of rules.
- Element hiding or cosmetic filtering.
- Any telemetry, including anonymous usage statistics.
