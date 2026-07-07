# VIGIL Matrix Lite — v0.9

An MV3-native, uMatrix-style request matrix for Chrome. Instead of observing and
blocking requests with `webRequest` (no longer viable for blocking in MV3), VIGIL
compiles your matrix decisions into **declarativeNetRequest (DNR)** rules that the
browser itself enforces.

## Core model

- **Rows** = target hosts, grouped per registrable domain (PSL-lite, including
  private suffixes such as `github.io`, `pages.dev`). Domain rows expand (▸)
  into indented **hostname rows**; a rule on `cdn.example.com` overrides a rule
  on `example.com` for that host and its subdomains.
- The **header row is the `*` row**: each column header carries the cell for
  ("all hosts", type) — click "Script" in the header to block scripts from
  everything. The leading **All column** is each row's (target, all-types) cell.
- **Columns** = All, cookie, CSS, font, image, media, script, XHR+
  (xhr / fetch / websocket / ping / beacon / other), frame.
- **Cells** cycle noop → block → allow (cookie: noop → block only). The most
  specific cell wins: hostname scope > domain scope > global; hostname target >
  domain target > `*`; specific type > All.
- **Scopes**: three levels — **global `*`**, the **registrable domain**, and the
  **full hostname** of the current page (button hidden when they coincide).

## Switches (per scope, applied immediately)

uMatrix-style toggles, shown as chips above the matrix for the active scope:

| Switch | Effect |
| --- | --- |
| Matrix off | Persistent `allowAllRequests` kill switch for the scope's frame tree. |
| No inline scripts | Appends a CSP header that disables inline `<script>` / inline handlers; external scripts stay governed by the matrix. |
| No workers | Appends `Content-Security-Policy: worker-src 'none'`. |
| Strip referrer | Removes the `Referer` header from requests in the scope. |
| HTTPS upgrade | `upgradeScheme` on `http://` requests (site scope: the site's own navigations + everything it initiates). |

Unlike matrix cells, switches have no draft layer: they commit the moment you flip them.

## Draft vs committed

Cell clicks become **draft** rules in DNR *session* rules immediately — try a
change live, reload the page, then **Save** to persist as *dynamic* rules or
**Revert**. Draft removals of committed cells are *neutralized* live by rules
that reproduce exactly what the less specific layers (or default-deny) would do.

> Known limitation: removing a *committed* cookie block via a draft has no live
> effect until you Save. Cookie stripping uses `modifyHeaders`, which can only be
> neutralized by removing the rule, not by a higher-priority allow.

## Built-in blocklist (static ruleset)

The extension ships a static DNR ruleset (`data/static-blocklist.json`,
disabled by default; toggle in Options). Static rules don't count against the
30k dynamic quota. Blocklist rules use priority 5, **below every matrix cell**,
so an explicit allow always overrides the list; `main_frame` is excluded so you
can still navigate to a listed domain. Rebuild from any hosts-format list:

```
node tools/build-blocklist.mjs my-hosts.txt -o data/static-blocklist.json
node tools/build-blocklist.mjs --from-classification   # bundled tracker list
```

## My rules (text editor)

Options → *My rules*: the entire committed policy as plain text — loadable,
diffable (added/removed lines vs the current state) and appliable. Great for
version control and sharing.

```
# <scope> <target> <type> block|allow
* doubleclick.net * block
news.example * script block          # default-deny scripts on news.example
news.example cdn.example script allow
news.example widget.example cookie block
switch: no-inline-script bank.example on
setting: default-deny on
```

Types: `* script xhr frame image css font media cookie`. IDN domains are
punycoded on parse. Lines that fail to parse are reported with line numbers and
block Apply.

## Other features

- **Default-deny mode** (options): a priority-1 block-all rule; anything not
  explicitly allowed is blocked. Allow cells (including `*`-row allows) punch
  through.
- **Cookie column**: strips `Cookie`/`Set-Cookie` per target; sits above all
  allow priorities. Site scopes exclude `main_frame`.
- **Observed-domain history**: previously seen domains and hostnames stay in
  the matrix even after their requests are blocked (200 sites / 80 targets per
  site / 12 raw hosts per target / 30-day TTL, stored locally).
- **Trust site (temp)**: session `allowAllRequests` for quick debugging — the
  persistent variant is the *Matrix off* switch.
- **Matched-rules viewer**: recent DNR matches for the tab, resolved against
  timestamped rule snapshots; distinguishes blocks, allows, cookie/referrer
  stripping, CSP injection, upgrades and kill-switch hits.
- **Side panel**, **all-frames scanning**, **quota display**, **JSON
  import/export** (schema versions 1–6 accepted, IDN normalized).

## Install (unpacked)

1. `chrome://extensions` → Developer mode → *Load unpacked* → this folder.
2. Open any http(s) page, click the VIGIL icon.

## Tests

```
node --test test/compiler.test.mjs
```

38 tests, including a miniature DNR evaluator that mirrors Chrome's priority,
tie-break, `modifyHeaders`-suppression and `upgradeScheme` semantics.

## Privacy

Everything is local: no backend, no telemetry, no remote code, no remote lists
fetched at runtime.
