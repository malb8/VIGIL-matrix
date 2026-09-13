import test from "node:test";
import assert from "node:assert/strict";
import { resolveOutcome } from "../src/lib/dnrCompiler.js";
import { explainOutcome, explanationLines, shouldRecommendBlock } from "../src/lib/policyExplanation.js";

const base = {
  contextHost: "www.example.com", scope: "example.com", target: "tracker.test",
  matrixType: "script", defaultMode: "relaxed", suffixes: new Set(),
  policies: {}, committedPolicies: {}
};
function check(context, action, source) {
  const result = explainOutcome(context);
  assert.equal(result.action, action);
  assert.equal(result.source, source);
  const resolved = resolveOutcome(context);
  if (source !== "draft-removal") assert.deepEqual({ action: result.action, coord: result.coord }, resolved);
  return result;
}

test("inspector attributes an explicit site allow overriding Relaxed", () => {
  const policies = { "example.com": { "tracker.test": { script: "allow" } } };
  const result = check({ ...base, policies, committedPolicies: policies }, "allow", "explicit");
  assert.equal(result.inherited, false);
  assert.deepEqual(result.coord, { scope: "example.com", target: "tracker.test", matrixType: "script" });
});

test("inspector attributes inherited global and parent-target rules", () => {
  for (const policies of [{ "*": { "*": { script: "block" } } }, { "example.com": { "tracker.test": { script: "block" } } }]) {
    const context = { ...base, target: "sub.tracker.test", policies, committedPolicies: policies };
    assert.equal(check(context, "block", "inherited").inherited, true);
  }
});

test("inspector attributes Relaxed default blocks and Open default allows", () => {
  assert.equal(check(base, "block", "default-mode").coord, null);
  check({ ...base, defaultMode: "open" }, "allow", "default-mode");
  for (const matrixType of ["image", "stylesheet", "font", "media"]) {
    check({ ...base, matrixType }, "allow", "default-mode");
  }
  check({ ...base, target: "cdn.example.com" }, "allow", "default-mode");
});

test("inspector identifies a draft overriding a saved cell", () => {
  const result = check({ ...base,
    policies: { "example.com": { "tracker.test": { script: "block" } } },
    committedPolicies: { "example.com": { "tracker.test": { script: "allow" } } }
  }, "block", "draft");
  assert.equal(result.draft, true);
});

test("inspector identifies a draft removal's default and inherited fallbacks", () => {
  const committedPolicies = { "example.com": { "tracker.test": { script: "block" } } };
  check({ ...base, defaultMode: "open", committedPolicies }, "allow", "draft-removal");
  check({ ...base, committedPolicies }, "block", "draft-removal");
  const inherited = { "*": { "tracker.test": { script: "allow" } } };
  const result = check({ ...base, policies: inherited, committedPolicies: { ...committedPolicies, ...inherited } }, "allow", "draft-removal");
  assert.equal(result.coord.scope, "example.com");
});

test("a more specific saved rule wins over a broader draft in the inspector", () => {
  const policies = {
    "example.com": { "tracker.test": { script: "block" } },
    "www.example.com": { "tracker.test": { script: "allow" } }
  };
  check({ ...base, policies, committedPolicies: { "www.example.com": policies["www.example.com"] } }, "allow", "inherited");
});

test("inspector does not attribute a static block just because the list is enabled", () => {
  const outcome = explainOutcome({ ...base, defaultMode: "open" });
  const lines = explanationLines(outcome, { ...base, blocklistEnabled: true });
  assert.equal(lines[0], "Allowed by matrix policy");
  assert.ok(lines.includes("Bundled blocklist is separate; not evaluated here"));
});

test("cookie explanation preserves saved stripping during draft removal", () => {
  const context = { ...base, matrixType: "cookie", defaultMode: "open",
    committedPolicies: { "example.com": { "tracker.test": { cookie: "block" } } }
  };
  const outcome = explainOutcome(context);
  assert.equal(outcome.action, "block");
  assert.equal(outcome.pendingRemoval, true);
  assert.ok(explanationLines(outcome, context).some((line) => line.includes("until Save")));
});

test("cookie explanation distinguishes Relaxed third-party stripping from first-party cookies", () => {
  assert.equal(explainOutcome({ ...base, matrixType: "cookie" }).action, "block");
  assert.equal(explainOutcome({ ...base, matrixType: "cookie", target: "cdn.example.com" }).action, "allow");
  assert.equal(explainOutcome({ ...base, matrixType: "cookie", defaultMode: "hard" }).action, "allow");
});

test("recommendations suppress already-blocked Relaxed actives and cookies", () => {
  for (const matrixType of ["script", "xmlhttprequest", "sub_frame", "cookie"]) {
    assert.equal(shouldRecommendBlock({ ...base, matrixType }), false);
  }
});

test("recommendations can tighten Open, suppress explicit blocks, and respect explicit allows", () => {
  assert.equal(shouldRecommendBlock({ ...base, defaultMode: "open" }), true);
  for (const action of ["allow", "block"]) {
    const policies = { "example.com": { "tracker.test": { script: action } } };
    assert.equal(shouldRecommendBlock({ ...base, policies, committedPolicies: policies }), action === "allow");
  }
});

test("recommendations do not propose a block that cannot override a more specific allow", () => {
  const policies = { "www.example.com": { "tracker.test": { script: "allow" } } };
  assert.equal(shouldRecommendBlock({ ...base, policies, committedPolicies: policies }), false);
});

test("trust and matrix-off are disclosed and suppress ineffective recommendations", () => {
  for (const bypass of [{ trustedSites: ["example.com"] }, { switches: { "*": { "matrix-off": true } } }]) {
    const context = { ...base, defaultMode: "open", ...bypass };
    assert.ok(explanationLines(explainOutcome(context), context)[0].startsWith("Matrix bypassed"));
    assert.equal(shouldRecommendBlock(context), false);
  }
});

test("recommendations defer unknown blocklist effects but an explicit allow is authoritative", () => {
  const context = { ...base, defaultMode: "open", blocklistEnabled: true };
  assert.equal(shouldRecommendBlock(context), false);
  const policies = { "example.com": { "tracker.test": { script: "allow" } } };
  assert.equal(shouldRecommendBlock({ ...context, policies, committedPolicies: policies }), true);
});

test("inherited cookie provenance identifies the saved global source", () => {
  const policies = { "*": { "tracker.test": { cookie: "block" } } };
  const context = { ...base, matrixType: "cookie", policies, committedPolicies: policies };
  const outcome = explainOutcome(context);
  assert.equal(outcome.inherited, true);
  assert.equal(outcome.coord.scope, "*");
  assert.ok(explanationLines(outcome, context).includes("Inherited cookie stripping rule"));
});

test("cookie recommendations remain effective with an explicit Hard-mode network allow", () => {
  for (const matrixType of ["script", "image"]) {
    const policies = { "example.com": { "tracker.test": { [matrixType]: "allow" } } };
    assert.equal(shouldRecommendBlock({ ...base, matrixType: "cookie", defaultMode: "hard",
      policies, committedPolicies: policies }), true);
  }
});
