import test from "node:test";
import assert from "node:assert/strict";
import { runPolicyApplyTransaction } from "../src/lib/policyApplyTransaction.js";

function harness({ failAt } = {}) {
  let persisted = "old-policy";
  let active = "old-rules";
  const snapshot = async () => ({ persisted, active });
  const rollback = async (previous) => {
    persisted = previous.persisted;
    active = previous.active;
  };
  const apply = async () => {
    if (failAt === "persist") throw new Error("storage write failed");
    persisted = "new-policy";
    if (failAt === "compile") throw new Error("compile failed: invalid policy");
    if (failAt === "dnr") throw new Error("DNR update failed: quota exceeded");
    active = "new-rules";
    return { ok: true };
  };
  return {
    run: () => runPolicyApplyTransaction({ snapshot, apply, rollback }),
    state: () => ({ persisted, active })
  };
}

test("successful policy apply activates and persists the new policy", async () => {
  const transaction = harness();
  assert.deepEqual(await transaction.run(), { ok: true });
  assert.deepEqual(transaction.state(), { persisted: "new-policy", active: "new-rules" });
});

test("compile failure preserves previous persisted policy and active rules", async () => {
  const transaction = harness({ failAt: "compile" });
  await assert.rejects(transaction.run(), /compile failed: invalid policy/);
  assert.deepEqual(transaction.state(), { persisted: "old-policy", active: "old-rules" });
});

test("DNR apply failure rolls back policy state and preserves the original error", async () => {
  const transaction = harness({ failAt: "dnr" });
  await assert.rejects(transaction.run(), /DNR update failed: quota exceeded/);
  assert.deepEqual(transaction.state(), { persisted: "old-policy", active: "old-rules" });
});

test("persistence failure rolls active rules back and is not reported as success", async () => {
  const transaction = harness({ failAt: "persist" });
  await assert.rejects(transaction.run(), /storage write failed/);
  assert.deepEqual(transaction.state(), { persisted: "old-policy", active: "old-rules" });
});

test("rollback failure never replaces the original apply error", async () => {
  const original = new Error("original apply failure");
  await assert.rejects(
    runPolicyApplyTransaction({
      snapshot: async () => ({}),
      apply: async () => { throw original; },
      rollback: async () => { throw new Error("rollback failure"); }
    }),
    (error) => error === original
  );
});
