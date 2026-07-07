# Threat Model

## Assets

1. The user's browsing: which third parties may execute/load what, per site.
2. The user's policy and observed-domain history (reveals browsing habits).
3. The integrity of enforcement: rules must mean what the matrix shows.

## Adversaries considered

### A1 — Third-party content embedded in visited pages
Trackers, ad networks, CDNs, widget providers loading scripts, frames,
beacons, media, fonts, styles and setting cookies.

**Controls:** DNR block/allow cells per (scope, target, type); cookie
stripping above all allow priorities; `*` row / default-deny for
deny-by-default postures; static blocklist; CSP switches for inline scripts
and workers; referrer stripping; HTTPS upgrade.

**Residual risk:** first-party or server-side tracking; resources delivered
over channels DNR does not classify as expected; CNAME-cloaked trackers
appear as first-party subdomains (mitigable by hostname-row blocks, not
automated); anything happening before rules are registered.

### A2 — A malicious or compromised visited page (first party)
May try to confuse the *scanner* (fake initiator types, unusual URLs) or
overwhelm history storage.

**Controls:** enforcement never depends on the scanner — DNR conditions
match what the network layer sees, not what the page claims. Scanner input
is treated as untrusted: URL parsing in try/catch, host validation before
storage, hard caps and TTL on history, all rendering of scanner-derived
strings escaped or set via `textContent`.

**Residual risk:** a page can hide resources from the *display* (they load
via mechanisms the Performance API misses); observed-domain history is
best-effort, which is why blocked-domain persistence exists.

### A3 — Malicious policy input (imported JSON, rules text, hosts lists)
A shared policy file could try to smuggle unexpected rules, non-ASCII
domains, absurd priorities or HTML into the UI.

**Controls:** imports are validated cell-by-cell (scope/target/type/action
whitelists), IDN-punycoded, and can only produce rules within VIGIL's own
priority bands and ID ranges; the rules-text parser rejects unknown
switches/settings/types with per-line errors and refuses to apply on any
error; the blocklist build tool emits only fixed-shape block rules at
priority 5. UI rendering of policy-derived strings is escaped.

**Residual risk:** a policy can still be *semantically* hostile (e.g. allow
rules for trackers). Review diffs before applying — the "My rules" diff
exists for exactly this.

### A4 — Other extensions / local software
Another extension with wider permissions can trivially do more than VIGIL
can prevent. Out of scope: VIGIL does not defend the browser from other
extensions or the OS.

### A5 — This project's own supply chain
**Controls:** zero runtime and build dependencies; no remote code (MV3
requirement and project rule); pure-module compiler with a node test suite
encoding the precedence invariants; releases from tagged commits.

**Residual risk:** the browser itself, and reviewer trust in this codebase —
which is the reason it is open source.

## Enforcement integrity invariants (normative)

The test suite enforces these; violations are security bugs (see SECURITY.md):

1. A more specific cell (scope > target > type) always wins over a less
   specific one, regardless of draft state.
2. A draft shadows only its own coordinate; it never outranks a more
   specific committed cell.
3. No allow rule can suppress cookie stripping (cookie band > all allows).
4. `*`-type and default-deny rules never match `main_frame` (navigation is
   never broken by a block-all).
5. Blocklist rules sit below every matrix cell: explicit user intent wins.
6. Only `matrix-off` and `trust-site` (`allowAllRequests`, priorities
   300/310) may bypass header rules, and both are explicit user actions.

## Non-goals

- Anonymity, fingerprinting resistance, VPN-like traffic protection.
- Malware/phishing detection or URL reputation.
- Defending users who install a hostile fork of this code.
