import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { normalizeDefaultMode } from "../src/lib/dnrCompiler.js";

const source = readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
const importSource = source.match(/^async function importState\(payload\) \{[\s\S]*?^\}/m)[0];
const assignment = importSource.slice(
  importSource.indexOf("nextSettings.defaultMode ="),
  importSource.indexOf("delete nextSettings.defaultDeny;")
);

test("import mode migrates legacy values, prefers explicit modes and preserves unspecified modes", () => {
  const cases = [
    { schemaVersion: 7, importedSettings: { defaultDeny: true }, current: "open", expected: "hard" },
    { schemaVersion: 7, importedSettings: { defaultDeny: false }, current: "hard", expected: "open" },
    { schemaVersion: 8, importedSettings: { defaultMode: "relaxed", defaultDeny: true }, current: "open", expected: "relaxed" },
    { schemaVersion: 8, importedSettings: { defaultMode: "open", defaultDeny: true }, current: "hard", expected: "open" },
    { schemaVersion: 8, importedSettings: { defaultMode: "hard", defaultDeny: false }, current: "open", expected: "hard" },
    { schemaVersion: 7, importedSettings: {}, current: "relaxed", expected: "relaxed" },
    { schemaVersion: 8, importedSettings: {}, current: "hard", expected: "hard" },
    { schemaVersion: 7, importedSettings: undefined, current: "hard", expected: "hard" }
  ];
  for (const { schemaVersion, importedSettings, current, expected } of cases) {
    const nextSettings = {};
    runInNewContext(assignment, {
      imported: { schemaVersion, settings: importedSettings },
      settings: { defaultMode: current },
      nextSettings,
      normalizeDefaultMode
    });
    assert.equal(nextSettings.defaultMode, expected, JSON.stringify({ schemaVersion, importedSettings, current }));
  }
});
