/*
 * VIGIL Matrix Lite - options page (v0.9, ES module)
 *
 * Adds to v0.8:
 * - Built-in static blocklist toggle (SET_BLOCKLIST).
 * - "My rules" text editor: load current rules as text, preview a line
 *   diff against the committed state, apply. Parsing/serialization/diffing
 *   live in src/lib/rulesText.js so the node test suite covers them.
 */
import { parseRulesText, serializeRulesText, diffRules } from "./lib/rulesText.js";

const policy = document.getElementById("policy");
const status = document.getElementById("status");
const modeRadios = Array.from(document.querySelectorAll('input[name="defaultMode"]'));
const blocklist = document.getElementById("blocklist");

function selectedMode() {
  return (modeRadios.find((r) => r.checked) || {}).value || "open";
}
function setModeRadio(mode) {
  const value = ["open", "relaxed", "hard"].includes(mode) ? mode : "open";
  for (const r of modeRadios) r.checked = (r.value === value);
}
const rulesText = document.getElementById("rulesText");
const rulesErrors = document.getElementById("rulesErrors");
const rulesDiffOut = document.getElementById("rulesDiffOut");

document.getElementById("load").addEventListener("click", () => loadJson().catch(showError));
document.getElementById("apply").addEventListener("click", () => applyJson().catch(showError));
document.getElementById("clear").addEventListener("click", () => { policy.value = ""; status.textContent = ""; });
document.getElementById("rulesLoad").addEventListener("click", () => loadRulesText().catch(showError));
document.getElementById("rulesDiff").addEventListener("click", () => previewDiff().catch(showError));
document.getElementById("rulesApply").addEventListener("click", () => applyRulesText().catch(showError));
for (const r of modeRadios) r.addEventListener("change", () => saveDefaultMode().catch(showError));
blocklist.addEventListener("change", () => saveBlocklist().catch(showError));

init().catch(showError);

async function init() {
  const state = await send({ type: "GET_STATE" });
  setModeRadio(state.settings?.defaultMode);
  blocklist.checked = Boolean(state.blocklistEnabled);
  await loadRulesText();
  await loadJson();
}

/* ---------------- My rules (text) ---------------- */

async function currentRulesState() {
  const state = await send({ type: "GET_STATE" });
  return {
    globalPolicy: state.globalPolicy || {},
    sitePolicies: state.sitePolicies || {},
    switches: state.switches || {},
    settings: {
      defaultMode: state.settings?.defaultMode || "open",
      blocklistEnabled: Boolean(state.blocklistEnabled)
    }
  };
}

async function loadRulesText() {
  rulesText.value = serializeRulesText(await currentRulesState());
  rulesErrors.textContent = "";
  rulesDiffOut.hidden = true;
  status.textContent = "Loaded committed rules as text.";
}

function parseEditor() {
  const parsed = parseRulesText(rulesText.value);
  if (parsed.errors.length) {
    rulesErrors.textContent = parsed.errors
      .map((e) => `line ${e.line}: ${e.message}\n    ${e.text}`)
      .join("\n");
  } else {
    rulesErrors.textContent = "";
  }
  return parsed;
}

async function previewDiff() {
  const parsed = parseEditor();
  const diff = diffRules(await currentRulesState(), parsed);
  const lines = [
    ...diff.removed.map((l) => `<span class="del">- ${escapeHtml(l)}</span>`),
    ...diff.added.map((l) => `<span class="add">+ ${escapeHtml(l)}</span>`)
  ];
  rulesDiffOut.innerHTML = lines.length ? lines.join("\n") : '<span class="muted">No changes.</span>';
  rulesDiffOut.hidden = false;
  status.textContent = parsed.errors.length
    ? "Diff shown for the lines that parsed; fix the errors above before applying."
    : `Diff: ${diff.added.length} added, ${diff.removed.length} removed.`;
}

async function applyRulesText() {
  const parsed = parseEditor();
  if (parsed.errors.length) {
    throw new Error(`Refusing to apply: ${parsed.errors.length} line(s) failed to parse.`);
  }
  const result = await send({
    type: "APPLY_RULES_TEXT",
    payload: {
      globalPolicy: parsed.globalPolicy,
      sitePolicies: parsed.sitePolicies,
      switches: parsed.switches,
      settings: parsed.settings
    }
  });
  const state = await send({ type: "GET_STATE" });
  setModeRadio(state.settings?.defaultMode);
  blocklist.checked = Boolean(state.blocklistEnabled);
  rulesDiffOut.hidden = true;
  status.textContent = `Rules applied. ${result.dynamic.added} saved DNR rules and ${result.session.added} temporary DNR rules active.`;
}

/* ---------------- JSON import/export ---------------- */

async function loadJson() {
  const result = await send({ type: "EXPORT_STATE" });
  policy.value = JSON.stringify(result.export, null, 2);
}

async function applyJson() {
  let parsed;
  try {
    parsed = JSON.parse(policy.value);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }
  const result = await send({ type: "IMPORT_STATE", payload: { import: parsed } });
  status.textContent = `Applied. Added ${result.dynamic.added} saved DNR rules and ${result.session.added} temporary DNR rules.`;
  await loadRulesText();
}

/* ---------------- Settings ---------------- */

async function saveDefaultMode() {
  const mode = selectedMode();
  const result = await send({ type: "SET_SETTINGS", payload: { settings: { defaultMode: mode } } });
  const note = mode === "hard"
    ? "block everything except explicit allows"
    : mode === "relaxed"
      ? "block third-party scripts/frames/XHR and strip third-party cookies"
      : "nothing blocked by default";
  status.textContent = `Default mode: ${mode} — ${note}. ${result.dynamic.added} saved DNR rules active.`;
}

async function saveBlocklist() {
  await send({ type: "SET_BLOCKLIST", payload: { enabled: blocklist.checked } });
  status.textContent = blocklist.checked
    ? "Built-in blocklist enabled (static ruleset)."
    : "Built-in blocklist disabled.";
}

/* ---------------- Plumbing ---------------- */

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else if (!response?.ok) reject(new Error(response?.error || "Unknown extension error"));
      else resolve(response);
    });
  });
}

function showError(error) {
  status.textContent = String(error?.message || error);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
