# Contributing

Thanks for considering a contribution. VIGIL Matrix is small on purpose;
the bar for adding code is "does this keep the extension explainable,
local-only and testable".

## Ground rules

1. **No runtime dependencies, no telemetry, no remote code.** PRs that add
   network calls, analytics, bundlers-with-dependency-trees or remotely
   fetched configuration will be declined regardless of convenience.
2. **The priority ladder is normative.** Any change touching
   `src/lib/dnrCompiler.js` must keep the invariants in
   `docs/ARCHITECTURE.md` true (drafts shadow their own coordinate only;
   cookie band above all allows; switches above the cookie band; etc.) and
   must come with evaluator tests proving it.
3. **Pure modules stay pure.** `src/lib/*` must not reference `chrome.*` —
   that is what makes the compiler and rules-text format testable in node.
4. **Tests are not optional** for behavior changes:
   `node --test test/compiler.test.mjs` must pass, and new precedence
   behavior needs new evaluator cases.
5. **Honest docs.** If your feature has an MV3 limitation, document it in
   ARCHITECTURE.md ("Known limitations") instead of papering over it.

## Developer Certificate of Origin (DCO)

This project uses the [DCO](https://developercertificate.org/) instead of a
CLA. Sign off every commit (`git commit -s`), which adds:

```
Signed-off-by: Your Name <your@email.example>
```

By signing off you certify you have the right to submit the work under the
project license (Apache-2.0).

## Workflow

- Fork → feature branch → small, reviewable PR. One concern per PR.
- Describe *what user-visible behavior changes* and *which priority-ladder
  or storage invariants are touched*.
- For UI changes, include a screenshot of the popup.
- For compiler changes, paste the relevant new test names in the PR body.

## Local development

```
# load unpacked: chrome://extensions -> Developer mode -> Load unpacked
node --test test/compiler.test.mjs      # run the suite
node --check src/background.js          # quick syntax check per file
node tools/build-blocklist.mjs --from-classification   # regenerate blocklist
```

There is no build step: the repository root is the extension.

## Reporting bugs

Use the issue tracker for functional bugs; include browser version, a
minimal policy (JSON export or "My rules" text) and the page where it
misbehaves. **Security issues go through SECURITY.md, not the tracker.**

## Style

- Modern ES modules, no transpilation, target `minimum_chrome_version` in
  the manifest.
- Comments explain *why* (design intent, DNR quirks), not *what*.
- Keep functions small; keep the compiler free of UI concerns and vice versa.
