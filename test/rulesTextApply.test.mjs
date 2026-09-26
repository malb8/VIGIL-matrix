import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalLines,
  diffRules,
  parseRulesText,
  resolveRulesTextApplyState
} from "../src/lib/rulesText.js";

function applyTarget(current, text) {
  const parsed = parseRulesText(text);
  assert.deepEqual(parsed.errors, []);
  return resolveRulesTextApplyState(current, parsed);
}

test("omitted settings are preserved and are not previewed as removals", () => {
  const current = {
    globalPolicy: {}, sitePolicies: {}, switches: {},
    settings: { defaultMode: "relaxed", blocklistEnabled: true }
  };
  const target = applyTarget(current, "");
  assert.equal(target.settings.defaultMode, "relaxed");
  assert.equal(target.settings.blocklistEnabled, true);
  assert.deepEqual(diffRules(current, target), { added: [], removed: [] });
});

test("explicit setting resets are applied and previewed as removals", () => {
  const current = {
    globalPolicy: {}, sitePolicies: {}, switches: {},
    settings: { defaultMode: "hard", blocklistEnabled: true }
  };
  const target = applyTarget(current, [
    "setting: default-mode open",
    "setting: blocklist off"
  ].join("\n"));
  assert.equal(target.settings.defaultMode, "open");
  assert.equal(target.settings.blocklistEnabled, false);
  assert.deepEqual(diffRules(current, target), {
    added: [],
    removed: ["setting: blocklist on", "setting: default-mode hard"]
  });
});

test("mixed rule change preserves omitted settings and preview matches the Apply target", () => {
  const current = {
    globalPolicy: { "old.example": { script: "block" } },
    sitePolicies: {}, switches: {},
    settings: { defaultMode: "relaxed", blocklistEnabled: true }
  };
  const target = applyTarget(current, "* new.example xhr block");
  assert.deepEqual(target.settings, current.settings);
  assert.deepEqual(diffRules(current, target), {
    added: ["* new.example xhr block"],
    removed: ["* old.example script block"]
  });
  assert.deepEqual(canonicalLines(target), [
    "* new.example xhr block",
    "setting: blocklist on",
    "setting: default-mode relaxed"
  ]);
});

test("ordinary rule additions, changes and removals keep existing diff behavior", () => {
  const current = {
    globalPolicy: {
      "change.example": { script: "block" },
      "remove.example": { image: "block" }
    },
    sitePolicies: {}, switches: {}, settings: { defaultMode: "open", blocklistEnabled: false }
  };
  const target = applyTarget(current, [
    "* change.example script allow",
    "* add.example frame block"
  ].join("\n"));
  assert.deepEqual(diffRules(current, target), {
    added: ["* add.example frame block", "* change.example script allow"],
    removed: ["* change.example script block", "* remove.example image block"]
  });
});
