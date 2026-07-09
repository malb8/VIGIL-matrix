# VIGIL Matrix

**Experimental, MV3-native, local-only request policy matrix for Chromium browsers.**

VIGIL Matrix is a browser extension for advanced users who want to inspect and
control third-party web execution per site — scripts, XHR/fetch/beacons,
frames, images, media, fonts, stylesheets and cookies — through a
matrix-based policy console inspired by matrix-style request control tools.

Instead of intercepting requests with the (no longer blocking-capable)
`webRequest` API, VIGIL compiles your decisions into
**declarativeNetRequest (DNR)** rules that the browser itself enforces.
Everything runs locally: no backend, no telemetry, no remote code, no remote
lists fetched at runtime.

> **Status: experimental research preview (v0.10).**
> Audience: advanced users, security architects, browser security researchers.
> Goal: MV3-native, matrix-based, explainable request policy control.
> Non-goals: full uMatrix compatibility, mass-market ad blocking, guaranteed
> tracking protection.

## Features

- **Policy matrix** with three scope levels (global `*`, registrable domain,
  full hostname) and a hostname hierarchy in the rows: a rule on
  `cdn.example.com` overrides a rule on `example.com` for that host.
- **Wildcard row and column**: the header row is the `*` row (per-type "block
  everywhere" cells); every row has an "All" cell covering all types.
- **Cookie column**: strips `Cookie` / `Set-Cookie` headers per target,
  engineered to survive any allow rule.
- **Per-scope switches**: matrix-off (persistent kill switch),
  no-inline-script (CSP), no-worker (CSP), strip-referrer, https-upgrade.
- **Draft vs committed**: cell clicks apply instantly as temporary session
  rules; Save persists, Revert discards. Draft previews use the same resolver
  the compiler uses, so what you see is what compiles.
- **Default-deny mode**: block everything not explicitly allowed.
- **Static blocklists**: bundled DNR ruleset (off by default) plus a build
  tool for hosts-format lists; explicit allows always override the list.
- **"My rules" text editor**: the whole policy as diffable plain text.
- **Matched-rules viewer**, observed-domain history, side panel, JSON
  import/export, quota display.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the priority-ladder
design and [CHANGELOG.md](CHANGELOG.md) for the version history.

## Install (unpacked)

1. Clone this repository.
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select the repository root.
4. Open any http(s) page and click the VIGIL icon.

There is currently no store release; see [docs/ROADMAP.md](docs/ROADMAP.md).

Currently review pending for VIGIL-matrix in the Edge Add-Ons store

## Tests

```
node --test test/compiler.test.mjs
```

The suite includes a miniature DNR evaluator that mirrors Chrome's priority,
tie-break, `modifyHeaders`-suppression and `upgradeScheme` semantics, so the
compiler's precedence model is verified without a browser.

## What VIGIL is not

- It does **not** guarantee that tracking, fingerprinting, malware or data
  leaks are blocked. See [DISCLAIMER.md](DISCLAIMER.md).
- It is **not** a uMatrix replacement. MV3 imposes real limits: no blocking
  `webRequest`, no unlimited match feedback (hence no live per-cell request
  counters), no visibility into requests DNR already blocked. The docs are
  explicit about every such limitation.

## Privacy, security, permissions

- [PRIVACY.md](PRIVACY.md) — what data exists, where it lives (spoiler: your
  machine), what never leaves it.
- [SECURITY.md](SECURITY.md) — reporting vulnerabilities.
- [docs/PERMISSIONS.md](docs/PERMISSIONS.md) — why each manifest permission
  exists.
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) — what VIGIL defends against,
  what it explicitly does not.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Small, reviewable PRs with tests are
the fastest to land. This project uses the Developer Certificate of Origin
(DCO): sign off your commits with `git commit -s`.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).
