# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** via GitHub's
"Report a vulnerability" (Security → Advisories → Report) on this repository.
Do not open a public issue for exploitable problems.

Include, where possible:

- affected version/commit and browser version;
- a minimal reproduction (policy JSON or "My rules" text plus steps);
- impact assessment: what can an attacker achieve, from which position
  (malicious website, malicious policy import, compromised list file)?

You can expect an acknowledgement within 7 days. Coordinated disclosure is
appreciated; we will credit reporters unless they prefer otherwise.

## Scope: what counts as a vulnerability here

Examples of reports we consider security-relevant:

- A page or frame that can **bypass a committed block/cookie/CSP rule** in a
  way not documented as an MV3 limitation.
- Policy import (JSON or rules text) leading to **code execution, HTML
  injection in the UI, or rule injection** beyond what the imported policy
  legitimately expresses.
- A crafted website able to **read or modify VIGIL's stored policy**.
- Priority-ladder flaws where a **less specific rule silently defeats a more
  specific one** (the invariants in `docs/ARCHITECTURE.md` are normative).
- The blocklist build tool producing rules that differ from the input list in
  an exploitable way.

## Explicit non-vulnerabilities (documented limitations)

These are known consequences of the MV3 design, documented in
`docs/ARCHITECTURE.md` and `DISCLAIMER.md`:

- Requests VIGIL never saw (fired before rules existed, or outside DNR's
  reach) are not blocked retroactively.
- Removing a committed cookie block via a draft takes effect only after Save.
- `getMatchedRules` quota limits the matched-rules viewer; there are no live
  per-cell counters.
- First-party pages can technically evade *classification heuristics* in the
  scanner; enforcement is done by DNR conditions, not by the scanner.
- Tracking via mechanisms DNR cannot see (e.g. first-party server-side
  tracking) is out of scope.

## Supply chain

- The extension has **zero runtime dependencies** and **zero build-time npm
  dependencies**; the test suite uses only `node:test`.
- No remote code or remote configuration is loaded, in line with MV3 policy.
- Releases are tagged; the published zip should be reproducible from the tag
  (`git archive` equivalence). Please report any release artifact that does
  not match its tag.
