# How VIGIL Matrix Works

This is the narrative version: what actually happens when you browse with
VIGIL Matrix installed. For the precise priority tables and compiler
internals, see [ARCHITECTURE.md](ARCHITECTURE.md).

## The MV3 inversion

Classic request-matrix tools (uMatrix, early uBlock) sat *inside* the traffic
stream: the browser asked the extension, per request, "may this pass?"
Manifest V3 removed that capability for public Chrome extensions.

VIGIL Matrix flips the model. It never sees your traffic at all. Instead, it
hands the browser a rulebook ahead of time — **declarativeNetRequest (DNR)**
rules compiled from your matrix decisions — and the browser enforces that
rulebook itself, natively, on every request.

One consequence is worth internalizing: **enforcement works even while the
extension is asleep.** The service worker can be suspended; your rules keep
applying. The extension only wakes up when *you* open the popup or change a
rule. Privacy and architecture are the same fact here: the extension cannot
leak traffic it never possesses.

## A page visit, step by step

Say your policy contains two decisions for `wsj.com`:
scripts from `doubleclick.net` → **block**, and cookies to `piwik.pro` →
**block**. You navigate to `www.wsj.com`.

**1. Before anything loads.** The browser already holds the compiled rules,
e.g.:

```json
{ "priority": 30, "action": { "type": "block" },
  "condition": { "initiatorDomains": ["wsj.com"],
                 "requestDomains": ["doubleclick.net"],
                 "resourceTypes": ["script"] } }

{ "priority": 82, "action": { "type": "modifyHeaders",
    "requestHeaders":  [{ "header": "cookie",     "operation": "remove" }],
    "responseHeaders": [{ "header": "set-cookie", "operation": "remove" }] },
  "condition": { "initiatorDomains": ["wsj.com"],
                 "requestDomains": ["piwik.pro"], "...": "..." } }
```

**2. The page loads.** WSJ requests ~50 resources. For each one, the
*browser* evaluates which rules match; the highest priority wins. The
doubleclick script is blocked before a single byte leaves your machine. The
piwik request goes out — but stripped of cookies. VIGIL's own code does not
run during any of this.

**3. You click the toolbar icon.** Only now does the extension wake up. A
scanner script is injected into the active tab (via `activeTab`, so only on
your click, only into that tab) and inventories what the page *did* load:
which hosts, which resource types. That inventory is merged with two other
sources:

- your **rules** (so every host you have a policy for gets a row), and
- the local **observation history** for this site (hosts seen on earlier
  visits).

This merge is why blocked domains stay visible. The scanner cannot see
requests that DNR already blocked — they never happened — so without
history, blocking a domain would make it vanish from the matrix and become
impossible to unblock. Rows the scanner didn't observe this time are
labeled *history (n)* or *policy/history only*.

**4. You click a cell** — say `googletagmanager.com` × script → block. That
single decision compiles instantly into a **temporary** rule in the session
store, at a priority exactly one above the saved slot for the same cell.
Reload the page: GTM no longer loads. Like it? **Save** moves the decision
into the persistent store (it now survives browser restarts). Don't?
**Revert** deletes the temporary rule and nothing has changed.

**5. Removing a rule live works too.** If you draft-remove a saved block,
VIGIL emits a *neutralizer*: a temporary rule at the same coordinate whose
action is whatever the less specific layers (or default-deny) would have
done. More specific rules keep winning, and the preview you see in the
popup is computed by the same resolver the compiler uses — what you see is
what compiles. (One documented exception: removing a saved **cookie** block
only takes effect after Save; see ARCHITECTURE.md.)

## "Most specific wins", without any runtime code

uMatrix resolved cell precedence in extension code, per request. VIGIL bakes
precedence into the rule **priority number** once, at compile time:

```
priority = 10 + scope*16 + target*4 + type*2 + draft
```

- scope: global (0) < registrable domain (1) < exact hostname (2)
- target: `*` (0) < domain (1) < subdomain (2) < deeper (3)
- type: all-types cell (0) < specific type (1)
- draft: saved (0) < temporary (1)

Example: you block all scripts globally (the `*` header cell → priority 12)
but allow scripts from `cdn.wsj.com` on this site (hostname target →
priority ~36). Both rules match a request to `cdn.wsj.com`; the browser
simply picks the higher number. The allow wins — exactly the uMatrix
behavior, computed by Chrome's own evaluator instead of ours.

The bands above the matrix are deliberate too: cookie-stripping rules
(80–103) outrank every allow, so allowing a script can never silently
re-enable its cookies. Switches (CSP injection, referrer stripping, HTTPS
upgrade) sit higher still, and only the explicit kill switches
(`matrix-off` at 300, temporary trust at 310) outrank everything.

## What each permission is doing in this story

| Moment | Permission at work |
| --- | --- |
| Rules enforced during browsing | `declarativeNetRequest` |
| Scanner injected when you open the popup | `activeTab` + `scripting` |
| Policy, switches and history stored locally | `storage` |
| "Matched rules" viewer and badge counter | `declarativeNetRequestFeedback` |
| Matrix open beside the page while you reload | `sidePanel` |

No host permissions, no `webRequest`, no background access to any tab.
Details and the reasoning per permission: [PERMISSIONS.md](PERMISSIONS.md).

## The honest trade-offs

The declarative model gives up things the old interception model had:

- **No live per-cell counters.** Nothing watches the stream, so nothing can
  count it in real time. The matched-rules viewer reconstructs recent
  matches afterwards, within a browser quota (~20 refreshes / 10 min).
- **No complete request log.** The scanner sees what loaded; DNR blocked
  what didn't; the gap between them is inferred, not observed.
- **Best-effort visibility.** Resources loaded through channels the
  Performance API misses won't appear as rows — but note that *enforcement*
  never depends on the scanner. DNR matches what the network layer sees,
  not what the page admits to.

We consider that a good trade: the extension that cannot see your traffic
also cannot abuse it.

## Where to go deeper

- [ARCHITECTURE.md](ARCHITECTURE.md) — priority ladder, compiler pipeline,
  draft semantics, known limitations
- [THREAT_MODEL.md](THREAT_MODEL.md) — what this defends against, and what
  it explicitly does not
- [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) — why it is built this way
- `test/compiler.test.mjs` — a miniature DNR evaluator proving the
  precedence model without a browser
