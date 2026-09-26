import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { runPolicyApplyTransaction } from "../src/lib/policyApplyTransaction.js";

const source = readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
const names = ["snapshotPolicyApplyState", "restoreStorageKeys", "restoreOwnedRules", "rollbackPolicyApplyState", "restoreEnabledRulesets"];
const functions = names.map((name) => source.match(new RegExp(`^async function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0] || "").join("\n");

for (const enabled of [false, true]) {
  test(`failed policy apply restores static blocklist ${enabled} as well as storage and rules`, async () => {
    const local = { settings: { blocklistEnabled: enabled } };
    const session = {};
    let rulesets = enabled ? ["blocklist"] : [];
    let dynamic = [{ id: 1 }];
    let temporary = [{ id: 101 }];
    const storage = (data) => ({
      get: async () => structuredClone(data),
      set: async (patch) => Object.assign(data, structuredClone(patch)),
      remove: async (keys) => keys.forEach((key) => delete data[key])
    });
    const api = {
      getEnabledRulesets: async () => [...rulesets],
      updateEnabledRulesets: async ({ enableRulesetIds, disableRulesetIds }) => {
        rulesets = [...new Set([...rulesets.filter((id) => !disableRulesetIds.includes(id)), ...enableRulesetIds])];
      },
      getDynamicRules: async () => structuredClone(dynamic),
      getSessionRules: async () => structuredClone(temporary),
      updateDynamicRules: async ({ addRules }) => { dynamic = structuredClone(addRules); },
      updateSessionRules: async ({ addRules }) => { temporary = structuredClone(addRules); }
    };
    const context = {
      chrome: { storage: { local: storage(local) }, declarativeNetRequest: api },
      draftStore: storage(session), POLICY_LOCAL_KEYS: ["settings"], POLICY_SESSION_KEYS: ["draftGlobalPolicy"],
      DYNAMIC_RULE_BASE_ID: 1, DYNAMIC_RULE_MAX_ID: 100,
      SESSION_RULE_BASE_ID: 101, SESSION_RULE_MAX_ID: 200
    };
    const handlers = runInNewContext(`${functions}\n({ snapshot: snapshotPolicyApplyState, rollback: rollbackPolicyApplyState })`, context);
    await assert.rejects(runPolicyApplyTransaction({
      ...handlers,
      apply: async () => {
        local.settings.blocklistEnabled = !enabled;
        rulesets = enabled ? [] : ["blocklist"];
        session.draftGlobalPolicy = { changed: true };
        dynamic = [{ id: 2 }];
        temporary = [{ id: 102 }];
        throw new Error("session compile failed");
      }
    }), /session compile failed/);
    assert.deepEqual(local, { settings: { blocklistEnabled: enabled } });
    assert.deepEqual(session, {});
    assert.deepEqual(dynamic, [{ id: 1 }]);
    assert.deepEqual(temporary, [{ id: 101 }]);
    assert.deepEqual(rulesets, enabled ? ["blocklist"] : []);
  });
}
