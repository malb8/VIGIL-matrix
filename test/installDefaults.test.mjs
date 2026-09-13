import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { normalizeDefaultMode, validateSitePolicies } from "../src/lib/dnrCompiler.js";

const source = readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
const initSource = source.match(/^async function ensureDefaultState\([^)]*\) \{[\s\S]*?^\}/m)[0];
function fixture(initial = {}) {
  const local = structuredClone(initial);
  const session = {};
  const storage = (data) => ({
    get: async () => structuredClone(data),
    set: async (patch) => Object.assign(data, structuredClone(patch))
  });
  const init = runInNewContext(`(${initSource})`, {
    chrome: { storage: { local: storage(local) } }, draftStore: storage(session),
    SCHEMA_VERSION: 8, normalizeDefaultMode, validateSitePolicies
  });
  return { local, init };
}

test("fresh installation starts relaxed with the bundled blocklist enabled", async () => {
  const { local, init } = fixture();
  await init("install");
  assert.equal(local.settings.defaultMode, "relaxed");
  assert.equal(local.settings.blocklistEnabled, true);
  assert.deepEqual(local.sitePolicies, {});
  assert.deepEqual(local.globalPolicy, {});
});

for (const defaultMode of ["open", "relaxed", "hard"]) {
  for (const blocklistEnabled of [false, true]) {
    test(`update preserves ${defaultMode} and blocklist ${blocklistEnabled}`, async () => {
      const settings = { schemaVersion: 8, defaultMode, blocklistEnabled };
      const { local, init } = fixture({ settings });
      await init("update");
      assert.deepEqual(local.settings, settings);
    });
  }
}

test("repeated install and startup never reseed a user's changed settings", async () => {
  const { local, init } = fixture();
  await init("install");
  local.settings.defaultMode = "open";
  local.settings.blocklistEnabled = false;
  await init("install");
  await init();
  assert.equal(local.settings.defaultMode, "open");
  assert.equal(local.settings.blocklistEnabled, false);
});

test("update without settings and install with legacy data keep old defaults", async () => {
  for (const [initial, reason] of [[{}, "update"], [{ policies: {} }, "install"], [{ sitePolicies: {} }, "install"]]) {
    const { local, init } = fixture(initial);
    await init(reason);
    assert.equal(local.settings.defaultMode, "open");
    assert.equal(local.settings.blocklistEnabled, false);
  }
});

test("legacy settings still migrate without enabling the blocklist", async () => {
  const { local, init } = fixture({ settings: { schemaVersion: 7, defaultDeny: true, blocklistEnabled: false } });
  await init("update");
  assert.equal(local.settings.defaultMode, "hard");
  assert.equal(local.settings.blocklistEnabled, false);
});

test("onInstalled passes its reason through bootstrap to initialization", async () => {
  let listener;
  let reason;
  const context = {
    chrome: { runtime: { onInstalled: { addListener: (fn) => { listener = fn; } } },
      declarativeNetRequest: { setExtensionActionOptions: async () => {} } },
    ensureDefaultState: async (value) => { reason = value; },
    applyBlocklistSetting: async () => {}, compileAndApplyDynamicRules: async () => {},
    compileAndApplySessionRules: async () => {}, serialize: (fn) => fn()
  };
  const bootstrap = source.match(/^async function bootstrap\([^)]*\) \{[\s\S]*?^\}/m)[0];
  const registration = source.match(/^chrome.runtime.onInstalled.addListener.*$/m)[0];
  runInNewContext(`${bootstrap}\n${registration}`, context);
  await listener({ reason: "install" });
  assert.equal(reason, "install");
  await listener({ reason: "update" });
  assert.equal(reason, "update");
});

test("missing settings on ordinary startup do not trigger fresh-install protection", async () => {
  const { local, init } = fixture();
  await init();
  assert.equal(local.settings.defaultMode, "open");
  assert.equal(local.settings.blocklistEnabled, false);
});

test("updates with partially missing settings never seed stronger defaults", async () => {
  for (const settings of [
    { schemaVersion: 8, blocklistEnabled: false },
    { schemaVersion: 8, defaultMode: "open" },
    { schemaVersion: 8 }
  ]) {
    const { local, init } = fixture({ settings });
    await init("update");
    assert.deepEqual(local.settings, settings);
  }
});
