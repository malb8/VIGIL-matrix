import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
const functionSource = source.match(/^function resolveMatch\(snapshots, currentIndex, info\) \{[\s\S]*?^\}/m)[0];
const resolveMatch = runInNewContext(`(${functionSource})`);

test("resolveMatch resolves API-shaped matches through snapshots and the current index", async () => {
  const rule = { id: 100000, action: "block" };
  const mockGetMatchedRules = async () => ({
    rulesMatchedInfo: [{
      rule: { ruleId: rule.id, rulesetId: "_dynamic" },
      tabId: 1,
      timeStamp: 2000
    }]
  });
  const { rulesMatchedInfo: [info] } = await mockGetMatchedRules();
  const snapshots = { dynamic: [{ ts: 1000, rules: [rule] }], session: [] };
  const saved = { store: "saved", rule };
  const currentIndex = new Map([[rule.id, saved]]);

  const historical = resolveMatch(snapshots, new Map(), info);
  assert.ok(historical, "API-shaped match must resolve from its snapshot");
  assert.equal(historical.store, "saved");
  assert.equal(historical.rule, rule);
  assert.equal(resolveMatch({}, currentIndex, info), saved);
});

test("getMatchedRules preserves the rule ID from an API-shaped match", async () => {
  const info = {
    rule: { ruleId: 100000, rulesetId: "_dynamic" },
    tabId: 1,
    timeStamp: 2000
  };
  const rule = { id: 100000, action: "block" };
  const getMatchedRulesSource = source.match(/^async function getMatchedRules\(payload\) \{[\s\S]*?^\}/m)[0];
  const getMatchedRules = runInNewContext(`(${getMatchedRulesSource})`, {
    resolveMatch,
    chrome: {
      declarativeNetRequest: {
        getMatchedRules: async () => ({ rulesMatchedInfo: [info] }),
        getDynamicRules: async () => [],
        getSessionRules: async () => []
      }
    },
    draftStore: {
      get: async () => ({
        ruleSnapshots: { dynamic: [{ ts: 1000, rules: [rule] }], session: [] }
      })
    }
  });

  const result = await getMatchedRules({ tabId: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].ruleId, info.rule.ruleId);
  assert.equal(result.matches[0].tabId, info.tabId);
  assert.equal(result.matches[0].timeStamp, info.timeStamp);
  assert.equal(result.matches[0].store, "saved");
  assert.equal(result.matches[0].action, "block");
});
