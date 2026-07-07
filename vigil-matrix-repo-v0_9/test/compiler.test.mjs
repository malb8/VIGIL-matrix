/*
 * VIGIL Matrix Lite compiler tests (v0.9)
 * Run: node --test test/
 *
 * Includes a miniature DNR evaluator implementing the Chrome semantics the
 * compiler relies on:
 * - among matching block/allow/allowAllRequests/upgradeScheme rules, the
 *   highest priority wins; on a tie, allow-type actions win over block;
 * - a matching modifyHeaders rule applies unless the request is blocked or
 *   an allow/allowAllRequests rule of equal-or-higher priority matches;
 * - urlFilter "|http://" matches requests with an http scheme.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { canonicalHost, registrableDomain, toAsciiDomain } from "../src/lib/domains.js";
import {
  PRIORITY, GLOBAL_SCOPE, TARGET_WILDCARD, TYPE_WILDCARD,
  compileCommittedRules,
  compileSessionRules,
  compactCells,
  collectCommittedCells,
  specsToRules,
  resolveOutcome,
  matrixPriority, cookiePriority, scopeLevel, targetSpecificity,
  DYNAMIC_RULE_BASE_ID
} from "../src/lib/dnrCompiler.js";
import { parseRulesText, serializeRulesText, canonicalLines, diffRules } from "../src/lib/rulesText.js";

/* ------------------------------------------------------------------ *
 * Mini DNR evaluator
 * ------------------------------------------------------------------ */

function domainMatches(list, domain) {
  if (!list || list.length === 0) return true;
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}

function ruleMatches(rule, req) {
  const c = rule.condition || {};
  const scheme = req.scheme || "https";
  if (c.urlFilter === "|http://" && scheme !== "http") return false;
  if (c.urlFilter && c.urlFilter !== "*" && c.urlFilter !== "|http://") {
    throw new Error(`evaluator does not support urlFilter ${c.urlFilter}`);
  }
  if (!domainMatches(c.requestDomains, req.domain)) return false;
  if (c.resourceTypes && !c.resourceTypes.includes(req.type)) return false;
  if (c.initiatorDomains && !domainMatches(c.initiatorDomains, req.initiator)) return false;
  return true;
}

const ROUTING_ACTIONS = ["block", "allow", "allowAllRequests", "upgradeScheme"];
// Chrome's tie-break order for equal priorities.
const ACTION_RANK = { allow: 0, allowAllRequests: 1, block: 2, upgradeScheme: 3 };

function evaluate(rules, req) {
  const matching = rules.filter((r) => ruleMatches(r, req));
  const routing = matching.filter((r) => ROUTING_ACTIONS.includes(r.action.type));
  let outcome = "default";
  let winning = null;
  if (routing.length) {
    routing.sort((a, b) => b.priority - a.priority || ACTION_RANK[a.action.type] - ACTION_RANK[b.action.type]);
    winning = routing[0];
    outcome = winning.action.type === "block" ? "blocked"
      : winning.action.type === "upgradeScheme" ? "upgraded"
      : "allowed";
  }
  let headerRules = [];
  if (outcome !== "blocked" && outcome !== "upgraded") {
    const allowPriority = winning && winning.action.type !== "block" ? winning.priority : -Infinity;
    headerRules = matching.filter((r) => r.action.type === "modifyHeaders" && r.priority > allowPriority);
  }
  const touched = new Set();
  for (const r of headerRules) {
    for (const h of r.action.requestHeaders || []) touched.add(h.header.toLowerCase());
    for (const h of r.action.responseHeaders || []) touched.add(h.header.toLowerCase());
  }
  return {
    outcome,
    headerRules,
    cookiesStripped: touched.has("cookie") || touched.has("set-cookie"),
    referrerStripped: touched.has("referer"),
    cspInjected: touched.has("content-security-policy")
  };
}

const SUFFIXES = new Set(["co.uk", "github.io", "s3.amazonaws.com"]);

/* ------------------------------------------------------------------ *
 * Domain normalization (unchanged module, kept as regression tests)
 * ------------------------------------------------------------------ */

test("registrableDomain: plain gTLD", () => {
  assert.equal(registrableDomain("www.example.com", SUFFIXES), "example.com");
  assert.equal(registrableDomain("a.b.c.example.com", SUFFIXES), "example.com");
});

test("registrableDomain: two-label public suffix", () => {
  assert.equal(registrableDomain("cdn.example.co.uk", SUFFIXES), "example.co.uk");
});

test("registrableDomain: private hosting suffix keeps tenants apart", () => {
  assert.equal(registrableDomain("alice.github.io", SUFFIXES), "alice.github.io");
  assert.equal(registrableDomain("deep.alice.github.io", SUFFIXES), "alice.github.io");
});

test("toAsciiDomain punycodes IDN input", () => {
  assert.equal(toAsciiDomain("münchen.de"), "xn--mnchen-3ya.de");
  assert.equal(toAsciiDomain("EXAMPLE.com"), "example.com");
  assert.throws(() => toAsciiDomain("not a domain/with/path"));
});

test("canonicalHost trims dots and lowercases", () => {
  assert.equal(canonicalHost(".Example.COM."), "example.com");
});

/* ------------------------------------------------------------------ *
 * Coordinate math
 * ------------------------------------------------------------------ */

test("scope level and target specificity", () => {
  assert.equal(scopeLevel(GLOBAL_SCOPE, SUFFIXES), 0);
  assert.equal(scopeLevel("example.com", SUFFIXES), 1);
  assert.equal(scopeLevel("app.example.com", SUFFIXES), 2);
  assert.equal(targetSpecificity(TARGET_WILDCARD, SUFFIXES), 0);
  assert.equal(targetSpecificity("example.com", SUFFIXES), 1);
  assert.equal(targetSpecificity("cdn.example.com", SUFFIXES), 2);
  assert.equal(targetSpecificity("a.b.cdn.example.com", SUFFIXES), 3); // capped
});

test("priority ladder ordering invariants", () => {
  // Draft never outranks a more specific committed coordinate.
  const committedMoreSpecific = matrixPriority({ s: 0, t: 2, y: 1, layer: 0 });
  const draftLessSpecific = matrixPriority({ s: 0, t: 1, y: 1, layer: 1 });
  assert.ok(committedMoreSpecific > draftLessSpecific);
  // Scope dominates target dominates type.
  assert.ok(matrixPriority({ s: 1, t: 0, y: 0, layer: 0 }) > matrixPriority({ s: 0, t: 3, y: 1, layer: 1 }));
  assert.ok(matrixPriority({ s: 0, t: 1, y: 0, layer: 0 }) > matrixPriority({ s: 0, t: 0, y: 1, layer: 1 }));
  // Cookie band sits above every matrix priority (so allows cannot disable
  // stripping) and below the switch bands.
  assert.ok(cookiePriority({ s: 0, t: 0, layer: 0 }) > matrixPriority({ s: 2, t: 3, y: 1, layer: 1 }));
  assert.ok(cookiePriority({ s: 2, t: 3, layer: 1 }) < PRIORITY.STRIP_REFERRER);
  assert.ok(PRIORITY.MATRIX_OFF > PRIORITY.CSP_NO_WORKER + 2);
  assert.ok(PRIORITY.TRUST_SITE > PRIORITY.MATRIX_OFF);
  assert.ok(PRIORITY.STATIC_BLOCKLIST < PRIORITY.MATRIX_BASE);
});

/* ------------------------------------------------------------------ *
 * Compaction
 * ------------------------------------------------------------------ */

test("compaction merges resource types and request domains", () => {
  const cells = collectCommittedCells({
    globalPolicy: {
      "tracker-a.com": { script: "block", xmlhttprequest: "block" },
      "tracker-b.com": { script: "block", xmlhttprequest: "block" },
      "tracker-c.com": { script: "block" }
    },
    sitePolicies: {},
    suffixes: SUFFIXES
  });
  const specs = compactCells(cells);
  assert.equal(specs.length, 2);
  const merged = specs.find((s) => s.targets.length === 2);
  assert.deepEqual(merged.targets, ["tracker-a.com", "tracker-b.com"]);
  assert.ok(merged.dnrTypes.includes("websocket")); // XHR column expansion
  assert.ok(merged.dnrTypes.includes("script"));
});

test("compaction never merges across scopes, actions or specificities", () => {
  const cells = collectCommittedCells({
    globalPolicy: {
      "x.com": { script: "block" },
      "cdn.x.com": { script: "block" } // more specific target: own priority
    },
    sitePolicies: { "site.com": { "x.com": { script: "block" } } },
    suffixes: SUFFIXES
  });
  const specs = compactCells(cells);
  assert.equal(specs.length, 3);
  const prios = new Set(specs.map((s) => s.priority));
  assert.equal(prios.size, 3);
});

test("rule ID exhaustion throws", () => {
  const specs = Array.from({ length: 5 }, (_, i) => ({
    scope: GLOBAL_SCOPE, kind: "block",
    priority: 20, dnrTypes: ["script"], targets: [`d${i}.com`]
  }));
  assert.throws(() => specsToRules(specs, 100, 102, "Test"));
});

/* ------------------------------------------------------------------ *
 * Precedence through the evaluator
 * ------------------------------------------------------------------ */

test("site block beats global allow; site allow beats global block", () => {
  const rules = compileCommittedRules({
    globalPolicy: {
      "cdn.example": { script: "allow" },
      "tracker.example": { script: "block" }
    },
    sitePolicies: {
      "news.example": {
        "cdn.example": { script: "block" },
        "tracker.example": { script: "allow" }
      }
    },
    suffixes: SUFFIXES
  });

  assert.equal(evaluate(rules, { domain: "cdn.example", type: "script", initiator: "news.example" }).outcome, "blocked");
  assert.equal(evaluate(rules, { domain: "cdn.example", type: "script", initiator: "other.example" }).outcome, "allowed");
  assert.equal(evaluate(rules, { domain: "tracker.example", type: "script", initiator: "news.example" }).outcome, "allowed");
  assert.equal(evaluate(rules, { domain: "tracker.example", type: "script", initiator: "other.example" }).outcome, "blocked");
});

test("hostname target overrides domain target (row hierarchy)", () => {
  const rules = compileCommittedRules({
    globalPolicy: {},
    sitePolicies: {
      "news.example.com": {
        "widgets.example": { script: "block" },
        "safe.widgets.example": { script: "allow" }
      }
    },
    suffixes: SUFFIXES
  });
  assert.equal(evaluate(rules, { domain: "cdn.widgets.example", type: "script", initiator: "news.example.com" }).outcome, "blocked");
  assert.equal(evaluate(rules, { domain: "safe.widgets.example", type: "script", initiator: "news.example.com" }).outcome, "allowed");
});

test("hostname scope overrides domain scope", () => {
  const rules = compileCommittedRules({
    globalPolicy: {},
    sitePolicies: {
      "example.com": { "cdn.example": { script: "block" } },
      "app.example.com": { "cdn.example": { script: "allow" } }
    },
    suffixes: SUFFIXES
  });
  // On app.example.com both scopes match; the hostname scope wins.
  assert.equal(evaluate(rules, { domain: "cdn.example", type: "script", initiator: "app.example.com" }).outcome, "allowed");
  // Elsewhere on example.com only the domain scope matches.
  assert.equal(evaluate(rules, { domain: "cdn.example", type: "script", initiator: "www.example.com" }).outcome, "blocked");
});

test("specific type cell overrides the type-* (All) cell", () => {
  const rules = compileCommittedRules({
    globalPolicy: {},
    sitePolicies: {
      "news.example": {
        "cdn.example": { [TYPE_WILDCARD]: "block", script: "allow" }
      }
    },
    suffixes: SUFFIXES
  });
  assert.equal(evaluate(rules, { domain: "cdn.example", type: "script", initiator: "news.example" }).outcome, "allowed");
  assert.equal(evaluate(rules, { domain: "cdn.example", type: "image", initiator: "news.example" }).outcome, "blocked");
});

test("type-* cells never touch main_frame navigation", () => {
  const rules = compileCommittedRules({
    globalPolicy: { [TARGET_WILDCARD]: { [TYPE_WILDCARD]: "block" } },
    sitePolicies: {},
    suffixes: SUFFIXES
  });
  assert.equal(evaluate(rules, { domain: "anything.example", type: "script", initiator: "x.example" }).outcome, "blocked");
  assert.equal(evaluate(rules, { domain: "anything.example", type: "main_frame", initiator: "" }).outcome, "default");
});

test("the * row blocks per type; concrete cells punch through", () => {
  const rules = compileCommittedRules({
    globalPolicy: { [TARGET_WILDCARD]: { script: "block" } },
    sitePolicies: { "news.example": { "cdn.example": { script: "allow" } } },
    suffixes: SUFFIXES
  });
  assert.equal(evaluate(rules, { domain: "random.example", type: "script", initiator: "news.example" }).outcome, "blocked");
  assert.equal(evaluate(rules, { domain: "random.example", type: "image", initiator: "news.example" }).outcome, "default");
  assert.equal(evaluate(rules, { domain: "cdn.example", type: "script", initiator: "news.example" }).outcome, "allowed");
});

test("XHR column governs beacons and websockets", () => {
  const rules = compileCommittedRules({
    globalPolicy: { "tracker.example": { xmlhttprequest: "block" } },
    sitePolicies: {},
    suffixes: SUFFIXES
  });
  for (const type of ["xmlhttprequest", "ping", "websocket", "other"]) {
    assert.equal(evaluate(rules, { domain: "tracker.example", type, initiator: "any.example" }).outcome, "blocked", type);
  }
});

test("default-deny blocks unknowns, user allows punch through", () => {
  const rules = compileCommittedRules({
    defaultDeny: true,
    globalPolicy: { "cdn.example": { script: "allow" } },
    sitePolicies: { "news.example": { "app.example": { xmlhttprequest: "allow" } } },
    suffixes: SUFFIXES
  });
  assert.equal(evaluate(rules, { domain: "random.example", type: "script", initiator: "news.example" }).outcome, "blocked");
  assert.equal(evaluate(rules, { domain: "cdn.example", type: "script", initiator: "news.example" }).outcome, "allowed");
  assert.equal(evaluate(rules, { domain: "app.example", type: "ping", initiator: "news.example" }).outcome, "allowed");
  assert.equal(evaluate(rules, { domain: "app.example", type: "ping", initiator: "other.example" }).outcome, "blocked");
});

/* ------------------------------------------------------------------ *
 * Cookie column
 * ------------------------------------------------------------------ */

test("cookie stripping survives site-level and draft allows", () => {
  const dynamic = compileCommittedRules({
    globalPolicy: { "widget.example": { cookie: "block" } },
    sitePolicies: { "news.example": { "widget.example": { script: "allow" } } },
    suffixes: SUFFIXES
  });
  const session = compileSessionRules({
    committedSitePolicies: { "news.example": { "widget.example": { script: "allow" } } },
    committedGlobalPolicy: { "widget.example": { cookie: "block" } },
    draftSitePolicies: { "app.news.example": { "widget.example": { script: "allow" } } },
    draftGlobalPolicy: null,
    trustedSites: [],
    suffixes: SUFFIXES
  });
  const all = [...dynamic, ...session];
  const viaCommitted = evaluate(all, { domain: "widget.example", type: "script", initiator: "news.example" });
  assert.equal(viaCommitted.outcome, "allowed");
  assert.equal(viaCommitted.cookiesStripped, true);
  const viaDraft = evaluate(all, { domain: "widget.example", type: "script", initiator: "app.news.example" });
  assert.equal(viaDraft.outcome, "allowed");
  assert.equal(viaDraft.cookiesStripped, true);
});

test("cookie cells only compile as block; allow is rejected", () => {
  assert.throws(() => compileCommittedRules({
    globalPolicy: { "x.example": { cookie: "allow" } },
    sitePolicies: {},
    suffixes: SUFFIXES
  }));
});

test("site cookie rules skip main_frame; global cookie rules include it", () => {
  const rules = compileCommittedRules({
    globalPolicy: { "g.example": { cookie: "block" } },
    sitePolicies: { "news.example": { "s.example": { cookie: "block" } } },
    suffixes: SUFFIXES
  });
  const globalCookie = rules.find((r) => r.condition.requestDomains?.includes("g.example"));
  const siteCookie = rules.find((r) => r.condition.requestDomains?.includes("s.example"));
  assert.ok(globalCookie.condition.resourceTypes.includes("main_frame"));
  assert.ok(!siteCookie.condition.resourceTypes.includes("main_frame"));
  assert.equal(siteCookie.priority, cookiePriority({ s: 1, t: 1, layer: 0 }));
});

/* ------------------------------------------------------------------ *
 * Draft overlays & neutralizers
 * ------------------------------------------------------------------ */

test("draft site block overrides committed global allow before save", () => {
  const committedGlobalPolicy = { "cdn.example": { script: "allow" } };
  const dynamic = compileCommittedRules({ globalPolicy: committedGlobalPolicy, sitePolicies: {}, suffixes: SUFFIXES });
  const session = compileSessionRules({
    committedSitePolicies: {},
    committedGlobalPolicy,
    draftSitePolicies: { "news.example": { "cdn.example": { script: "block" } } },
    draftGlobalPolicy: null,
    trustedSites: [],
    suffixes: SUFFIXES
  });
  const all = [...dynamic, ...session];
  assert.equal(evaluate(all, { domain: "cdn.example", type: "script", initiator: "news.example" }).outcome, "blocked");
  assert.equal(evaluate(all, { domain: "cdn.example", type: "script", initiator: "other.example" }).outcome, "allowed");
});

test("draft noop neutralizes a committed global block before save", () => {
  const committedGlobalPolicy = { "tracker.example": { script: "block" } };
  const dynamic = compileCommittedRules({ globalPolicy: committedGlobalPolicy, sitePolicies: {}, suffixes: SUFFIXES });
  const session = compileSessionRules({
    committedSitePolicies: {},
    committedGlobalPolicy,
    draftSitePolicies: {},
    draftGlobalPolicy: {}, // user removed the block in the draft
    trustedSites: [],
    suffixes: SUFFIXES
  });
  const all = [...dynamic, ...session];
  assert.equal(evaluate(all, { domain: "tracker.example", type: "script", initiator: "any.example" }).outcome, "allowed");
});

test("draft site noop over committed site rule reveals the global layer", () => {
  const committedSitePolicies = { "news.example": { "cdn.example": { script: "allow" } } };
  const committedGlobalPolicy = { "cdn.example": { script: "block" } };
  const dynamic = compileCommittedRules({ globalPolicy: committedGlobalPolicy, sitePolicies: committedSitePolicies, suffixes: SUFFIXES });
  const session = compileSessionRules({
    committedSitePolicies,
    committedGlobalPolicy,
    draftSitePolicies: { "news.example": {} }, // user cleared the site allow
    draftGlobalPolicy: null,
    trustedSites: [],
    suffixes: SUFFIXES
  });
  const all = [...dynamic, ...session];
  assert.equal(evaluate(all, { domain: "cdn.example", type: "script", initiator: "news.example" }).outcome, "blocked");
});

test("neutralizer respects default-deny: removed block stays blocked", () => {
  const committedGlobalPolicy = { "tracker.example": { script: "block" } };
  const dynamic = compileCommittedRules({ globalPolicy: committedGlobalPolicy, sitePolicies: {}, defaultDeny: true, suffixes: SUFFIXES });
  const session = compileSessionRules({
    committedSitePolicies: {},
    committedGlobalPolicy,
    draftSitePolicies: {},
    draftGlobalPolicy: {}, // removed the block, but default-deny is on
    trustedSites: [],
    defaultDeny: true,
    suffixes: SUFFIXES
  });
  const all = [...dynamic, ...session];
  assert.equal(evaluate(all, { domain: "tracker.example", type: "script", initiator: "any.example" }).outcome, "blocked");
});

test("neutralizer falls back on a hostname-target draft cell (merged view)", () => {
  // Committed: site blocks the whole widgets.example domain.
  // Draft: removes that domain block AND allows only safe.widgets.example.
  const committedSitePolicies = { "news.example": { "widgets.example": { script: "block" } } };
  const dynamic = compileCommittedRules({ globalPolicy: {}, sitePolicies: committedSitePolicies, suffixes: SUFFIXES });
  const session = compileSessionRules({
    committedSitePolicies,
    committedGlobalPolicy: {},
    draftSitePolicies: { "news.example": { "safe.widgets.example": { script: "allow" } } },
    draftGlobalPolicy: null,
    trustedSites: [],
    suffixes: SUFFIXES
  });
  const all = [...dynamic, ...session];
  assert.equal(evaluate(all, { domain: "safe.widgets.example", type: "script", initiator: "news.example" }).outcome, "allowed");
  assert.equal(evaluate(all, { domain: "ads.widgets.example", type: "script", initiator: "news.example" }).outcome, "allowed"); // neutralized
});

test("trust site bypasses blocks and cookie stripping", () => {
  const committedGlobalPolicy = { "tracker.example": { script: "block", cookie: "block" } };
  const dynamic = compileCommittedRules({ globalPolicy: committedGlobalPolicy, sitePolicies: {}, suffixes: SUFFIXES });
  const session = compileSessionRules({
    committedSitePolicies: {},
    committedGlobalPolicy,
    draftSitePolicies: {},
    draftGlobalPolicy: null,
    trustedSites: ["news.example"],
    suffixes: SUFFIXES
  });
  const all = [...dynamic, ...session];
  const mainFrame = evaluate(all, { domain: "news.example", type: "main_frame", initiator: "" });
  assert.equal(mainFrame.outcome, "allowed");
  const trust = all.find((r) => r.action.type === "allowAllRequests");
  assert.equal(trust.priority, PRIORITY.TRUST_SITE);
});

/* ------------------------------------------------------------------ *
 * Switches
 * ------------------------------------------------------------------ */

test("strip-referrer: site scope excludes main_frame, global includes it", () => {
  const rules = compileCommittedRules({
    globalPolicy: {}, sitePolicies: {},
    switches: { "*": { "strip-referrer": true }, "news.example": { "strip-referrer": true } },
    suffixes: SUFFIXES
  });
  const referers = rules.filter((r) => (r.action.requestHeaders || []).some((h) => h.header === "referer"));
  assert.equal(referers.length, 2);
  const globalRule = referers.find((r) => !r.condition.initiatorDomains);
  const siteRule = referers.find((r) => r.condition.initiatorDomains);
  assert.ok(globalRule.condition.resourceTypes.includes("main_frame"));
  assert.ok(!siteRule.condition.resourceTypes.includes("main_frame"));
  assert.deepEqual(siteRule.condition.initiatorDomains, ["news.example"]);
  const result = evaluate(rules, { domain: "cdn.example", type: "script", initiator: "news.example" });
  assert.equal(result.referrerStripped, true);
});

test("https-upgrade: upgrades http and leaves https alone; site scope compiles two rules", () => {
  const rules = compileCommittedRules({
    globalPolicy: {}, sitePolicies: {},
    switches: { "news.example": { "https-upgrade": true } },
    suffixes: SUFFIXES
  });
  const upgrades = rules.filter((r) => r.action.type === "upgradeScheme");
  assert.equal(upgrades.length, 2); // main_frame (requestDomains) + subresources (initiatorDomains)
  assert.equal(evaluate(rules, { domain: "news.example", type: "main_frame", initiator: "", scheme: "http" }).outcome, "upgraded");
  assert.equal(evaluate(rules, { domain: "cdn.example", type: "script", initiator: "news.example", scheme: "http" }).outcome, "upgraded");
  assert.equal(evaluate(rules, { domain: "cdn.example", type: "script", initiator: "news.example", scheme: "https" }).outcome, "default");
  assert.equal(evaluate(rules, { domain: "cdn.example", type: "script", initiator: "other.example", scheme: "http" }).outcome, "default");
});

test("CSP switches inject headers on documents of the scope", () => {
  const rules = compileCommittedRules({
    globalPolicy: {}, sitePolicies: {},
    switches: { "bank.example": { "no-inline-script": true, "no-worker": true } },
    suffixes: SUFFIXES
  });
  const page = evaluate(rules, { domain: "bank.example", type: "main_frame", initiator: "" });
  assert.equal(page.cspInjected, true);
  const values = page.headerRules.flatMap((r) => (r.action.responseHeaders || []).map((h) => h.value));
  assert.ok(values.some((v) => v.startsWith("script-src")));
  assert.ok(values.includes("worker-src 'none'"));
  const frame = evaluate(rules, { domain: "widgets.example", type: "sub_frame", initiator: "bank.example" });
  assert.equal(frame.cspInjected, true);
  const unrelated = evaluate(rules, { domain: "other.example", type: "main_frame", initiator: "" });
  assert.equal(unrelated.cspInjected, false);
});

test("matrix-off beats cookie stripping and blocks (persistent kill switch)", () => {
  const rules = compileCommittedRules({
    globalPolicy: { "news.example": { cookie: "block" }, [TARGET_WILDCARD]: { script: "block" } },
    sitePolicies: {},
    switches: { "news.example": { "matrix-off": true } },
    suffixes: SUFFIXES
  });
  const off = rules.find((r) => r.action.type === "allowAllRequests");
  assert.equal(off.priority, PRIORITY.MATRIX_OFF);
  const mainFrame = evaluate(rules, { domain: "news.example", type: "main_frame", initiator: "" });
  assert.equal(mainFrame.outcome, "allowed");
  assert.equal(mainFrame.cookiesStripped, false);
});

/* ------------------------------------------------------------------ *
 * Static blocklist interplay
 * ------------------------------------------------------------------ */

test("an explicit allow cell overrides a blocklist rule", () => {
  const blocklistRule = {
    id: 1,
    priority: PRIORITY.STATIC_BLOCKLIST,
    action: { type: "block" },
    condition: { requestDomains: ["tracker.example"], resourceTypes: ["script", "image"] }
  };
  const rules = compileCommittedRules({
    globalPolicy: {},
    sitePolicies: { "news.example": { "tracker.example": { script: "allow" } } },
    suffixes: SUFFIXES
  });
  const all = [blocklistRule, ...rules];
  assert.equal(evaluate(all, { domain: "tracker.example", type: "script", initiator: "news.example" }).outcome, "allowed");
  assert.equal(evaluate(all, { domain: "tracker.example", type: "image", initiator: "news.example" }).outcome, "blocked");
});

/* ------------------------------------------------------------------ *
 * resolveOutcome (shared inheritance preview)
 * ------------------------------------------------------------------ */

test("resolveOutcome walks scope, target and type chains", () => {
  const policies = {
    "*": { [TARGET_WILDCARD]: { script: "block" } },
    "example.com": { "widgets.example": { [TYPE_WILDCARD]: "allow" } },
    "app.example.com": { "safe.widgets.example": { script: "block" } }
  };
  // Most specific cell wins for its exact target...
  assert.equal(resolveOutcome({
    contextHost: "app.example.com", target: "safe.widgets.example", matrixType: "script",
    policies, suffixes: SUFFIXES
  }).action, "block");
  // ...siblings fall back to the domain-scope type-* allow...
  assert.equal(resolveOutcome({
    contextHost: "app.example.com", target: "cdn.widgets.example", matrixType: "script",
    policies, suffixes: SUFFIXES
  }).action, "allow");
  // ...and unrelated targets land on the global * row.
  const fallback = resolveOutcome({
    contextHost: "app.example.com", target: "random.example", matrixType: "script",
    policies, suffixes: SUFFIXES
  });
  assert.equal(fallback.action, "block");
  assert.equal(fallback.coord.scope, "*");
});

/* ------------------------------------------------------------------ *
 * Rules text (My rules)
 * ------------------------------------------------------------------ */

test("rules text: parse, aliases, switches, settings and errors", () => {
  const parsed = parseRulesText([
    "# comment",
    "* doubleclick.net * block",
    "news.example cdn.example xhr allow",
    "news.example widget.example cookie block",
    "switch: no-inline-script bank.example on",
    "switch: matrix-off dev.example on",
    "setting: default-deny on",
    "bogus line here",
    "news.example cdn.example script maybe"
  ].join("\n"));

  assert.equal(parsed.globalPolicy["doubleclick.net"]["*"], "block");
  assert.equal(parsed.sitePolicies["news.example"]["cdn.example"].xmlhttprequest, "allow");
  assert.equal(parsed.sitePolicies["news.example"]["widget.example"].cookie, "block");
  assert.equal(parsed.switches["bank.example"]["no-inline-script"], true);
  assert.equal(parsed.switches["dev.example"]["matrix-off"], true);
  assert.equal(parsed.settings.defaultDeny, true);
  assert.equal(parsed.errors.length, 2);
  assert.equal(parsed.errors[0].line, 8);
  assert.equal(parsed.errors[1].line, 9);
});

test("rules text: IDN scopes/targets are punycoded", () => {
  const parsed = parseRulesText("münchen.de tracker.example script block");
  assert.ok(parsed.sitePolicies["xn--mnchen-3ya.de"]);
  assert.equal(parsed.errors.length, 0);
});

test("rules text: serialize -> parse round-trips to identical canonical lines", () => {
  const state = {
    globalPolicy: { "doubleclick.net": { "*": "block" }, "*": { script: "block" } },
    sitePolicies: {
      "news.example": { "cdn.example": { xmlhttprequest: "allow", cookie: "block" } },
      "app.news.example": { "safe.example": { script: "allow" } }
    },
    switches: { "bank.example": { "no-inline-script": true, "https-upgrade": true } },
    settings: { defaultDeny: true, blocklistEnabled: true }
  };
  const text = serializeRulesText(state);
  const parsed = parseRulesText(text);
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(canonicalLines(parsed), canonicalLines(state));
});

test("rules text: diff reports added and removed lines", () => {
  const current = {
    globalPolicy: { "a.example": { script: "block" } },
    sitePolicies: {}, switches: {}, settings: {}
  };
  const next = {
    globalPolicy: { "b.example": { script: "block" } },
    sitePolicies: {}, switches: { "x.example": { "no-worker": true } }, settings: {}
  };
  const diff = diffRules(current, next);
  assert.deepEqual(diff.removed, ["* a.example script block"]);
  assert.deepEqual(diff.added.sort(), ["* b.example script block", "switch: no-worker x.example on"]);
});

/* ------------------------------------------------------------------ *
 * IDs
 * ------------------------------------------------------------------ */

test("dynamic rules start at the reserved base ID", () => {
  const rules = compileCommittedRules({
    globalPolicy: { "x.example": { script: "block" } },
    sitePolicies: {},
    suffixes: SUFFIXES
  });
  assert.equal(rules[0].id, DYNAMIC_RULE_BASE_ID);
});
