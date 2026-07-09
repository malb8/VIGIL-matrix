/*
 * VIGIL Matrix Lite - background service worker (v0.9, ES module)
 *
 * v0.9 changes vs v0.8:
 * - Scope keys are now "*" (global), a registrable domain, or a full
 *   hostname; targets may likewise be "*", a domain, or a hostname; and the
 *   type "*" (all types) exists. The compiler encodes specificity into the
 *   DNR priority, so no dispatch changes are needed here beyond passing the
 *   PSL-lite suffix list into every compile.
 * - Per-scope switches (matrix-off, no-inline-script, no-worker,
 *   strip-referrer, https-upgrade) are committed immediately via SET_SWITCH
 *   and compiled into the dynamic store.
 * - Optional built-in static blocklist ruleset, toggled with SET_BLOCKLIST
 *   (chrome.declarativeNetRequest.updateEnabledRulesets). Static rules do
 *   not count against the dynamic-rule quota.
 * - APPLY_RULES_TEXT replaces the committed policy from the parsed "My
 *   rules" text representation (parsing/diffing happens in the options page
 *   with src/lib/rulesText.js; this side only validates and applies).
 * - defaultDeny changes now also recompile SESSION rules: draft-noop
 *   neutralizers resolve to block under default-deny and allow otherwise.
 *
 * Carried over from v0.8: serialized operation queue (compile mutex),
 * timestamped rule snapshots for stable matched-rule attribution,
 * observed-domain history, temporary trust-site, punycode import, quota
 * reporting. No backend. No telemetry. No remote code.
 */

import {
  DYNAMIC_RULE_BASE_ID, DYNAMIC_RULE_MAX_ID,
  SESSION_RULE_BASE_ID, SESSION_RULE_MAX_ID,
  MATRIX_TYPES, SWITCH_NAMES, GLOBAL_SCOPE, MAX_NESTING_DEPTH,
  compileCommittedRules, compileSessionRules, findSpecificityConflicts,
  validateSitePolicies, validateTargetPolicy, validateMatrixType,
  validateAction, validateDomain, validateScope, validateSwitches,
  isEmptyTargetPolicy
} from "./lib/dnrCompiler.js";
import { toAsciiDomain, isValidAsciiDomain } from "./lib/domains.js";

const SCHEMA_VERSION = 7; // v0.10: real-depth scope/target specificity (no stored-data shape change)
const draftStore = chrome.storage.session;

const OBSERVED_MAX_SITES = 200;
const OBSERVED_MAX_TARGETS_PER_SITE = 80;
const OBSERVED_MAX_RAW_HOSTS = 12;
const OBSERVED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SNAPSHOT_HISTORY = 6;
const BLOCKLIST_RULESET_ID = "blocklist";

/* ------------------------------------------------------------------ *
 * Serialized operation queue (compile mutex)
 *
 * Every dispatched message runs to completion before the next starts, so
 * concurrent popup/options messages can never interleave two
 * updateDynamicRules/updateSessionRules read-modify-write cycles.
 * ------------------------------------------------------------------ */

let opQueue = Promise.resolve();
function serialize(fn) {
  const run = opQueue.then(fn, fn);
  opQueue = run.catch(() => {});
  return run;
}

/* ------------------------------------------------------------------ *
 * PSL-lite suffixes (needed for scope/target specificity in the compiler)
 * ------------------------------------------------------------------ */

const FALLBACK_SUFFIXES = ["co.uk", "org.uk", "com.au", "com.br", "co.nz", "co.jp", "github.io", "pages.dev"];
let suffixesPromise = null;

function loadSuffixes() {
  suffixesPromise ||= (async () => {
    try {
      const response = await fetch(chrome.runtime.getURL("data/domain-classification.json"));
      const data = await response.json();
      const list = Array.isArray(data?.registrableDomainSuffixes) ? data.registrableDomainSuffixes : FALLBACK_SUFFIXES;
      return new Set(list);
    } catch (_) {
      return new Set(FALLBACK_SUFFIXES);
    }
  })();
  return suffixesPromise;
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

async function bootstrap() {
  await chrome.declarativeNetRequest.setExtensionActionOptions({
    displayActionCountAsBadgeText: true
  });
  await ensureDefaultState();
  await applyBlocklistSetting();
  await compileAndApplyDynamicRules();
  await compileAndApplySessionRules();
}

chrome.runtime.onInstalled.addListener(() => serialize(bootstrap));
chrome.runtime.onStartup?.addListener(() => serialize(bootstrap));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  serialize(() => dispatch(message))
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true; // async sendResponse
});

async function dispatch(message) {
  if (!message || !message.type) return null;
  switch (message.type) {
    case "GET_STATE": return getState();
    case "APPLY_DRAFT_SITE_POLICY": return applyDraftSitePolicy(message.payload);
    case "APPLY_DRAFT_GLOBAL_POLICY": return applyDraftGlobalPolicy(message.payload);
    case "COMMIT_SITE_POLICY": return commitSitePolicy(message.payload);
    case "COMMIT_GLOBAL_POLICY": return commitGlobalPolicy(message.payload);
    case "REVERT_SITE_POLICY": return revertSitePolicy(message.payload);
    case "REVERT_GLOBAL_POLICY": return revertGlobalPolicy();
    case "CLEAR_SITE_POLICY": return clearSitePolicy(message.payload);
    case "CLEAR_GLOBAL_POLICY": return clearGlobalPolicy();
    case "SET_SETTINGS": return setSettings(message.payload);
    case "SET_SWITCH": return setSwitch(message.payload);
    case "SET_BLOCKLIST": return setBlocklist(message.payload);
    case "SET_TRUSTED_SITE": return setTrustedSite(message.payload);
    case "RECORD_SCAN": return recordScan(message.payload);
    case "COMPILE_RULES": return compileAllRules();
    case "EXPORT_STATE": return exportState();
    case "IMPORT_STATE": return importState(message.payload);
    case "APPLY_RULES_TEXT": return applyRulesText(message.payload);
    case "GET_MATCHED_RULES": return getMatchedRules(message.payload);
    default: return { ok: false, error: `Unknown message type: ${message.type}` };
  }
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

async function ensureDefaultState() {
  const local = await chrome.storage.local.get(
    ["sitePolicies", "globalPolicy", "policies", "switches", "settings", "observedDomains"]
  );

  // v0.1/v0.2 migration: `policies` was the site-scoped policy store.
  if (!local.sitePolicies && local.policies) {
    validateSitePolicies(local.policies || {});
    await chrome.storage.local.set({ sitePolicies: local.policies || {} });
  }
  if (!local.sitePolicies) await chrome.storage.local.set({ sitePolicies: {} });
  if (!local.globalPolicy) await chrome.storage.local.set({ globalPolicy: {} });
  if (!local.switches) await chrome.storage.local.set({ switches: {} }); // v0.9
  if (!local.observedDomains) await chrome.storage.local.set({ observedDomains: {} });

  const defaults = {
    defaultCellState: "noop",
    normalizeToRegistrableDomain: "psl-lite",
    defaultDeny: false,
    blocklistEnabled: false,
    schemaVersion: SCHEMA_VERSION
  };
  if (!local.settings) {
    await chrome.storage.local.set({ settings: defaults });
  } else if (local.settings.schemaVersion !== SCHEMA_VERSION) {
    // Forward migration is additive: unknown new keys get their defaults.
    await chrome.storage.local.set({ settings: { ...defaults, ...local.settings, schemaVersion: SCHEMA_VERSION } });
  }

  const draft = await draftStore.get(["draftSitePolicies", "draftGlobalPolicy", "trustedSites"]);
  if (!draft.draftSitePolicies) await draftStore.set({ draftSitePolicies: {} });
  if (typeof draft.draftGlobalPolicy === "undefined") await draftStore.set({ draftGlobalPolicy: null });
  if (!Array.isArray(draft.trustedSites)) await draftStore.set({ trustedSites: [] });
}

async function getState() {
  await ensureDefaultState();
  const { sitePolicies = {}, globalPolicy = {}, switches = {}, settings = {} } =
    await chrome.storage.local.get(["sitePolicies", "globalPolicy", "switches", "settings"]);
  const { draftSitePolicies = {}, draftGlobalPolicy = null, trustedSites = [] } =
    await draftStore.get(["draftSitePolicies", "draftGlobalPolicy", "trustedSites"]);
  const dynamicRules = await chrome.declarativeNetRequest.getDynamicRules();
  const sessionRules = await chrome.declarativeNetRequest.getSessionRules();

  let enabledStaticRulesets = [];
  try {
    enabledStaticRulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
  } catch (_) { /* no static rulesets declared */ }

  return {
    ok: true,
    sitePolicies,
    globalPolicy,
    switches,
    draftSitePolicies,
    draftGlobalPolicy,
    trustedSites,
    settings,
    blocklistEnabled: enabledStaticRulesets.includes(BLOCKLIST_RULESET_ID),
    dynamicRuleCount: countOwnedRules(dynamicRules, DYNAMIC_RULE_BASE_ID, DYNAMIC_RULE_MAX_ID),
    sessionRuleCount: countOwnedRules(sessionRules, SESSION_RULE_BASE_ID, SESSION_RULE_MAX_ID),
    dynamicRuleLimit: chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES ?? 30000,
    sessionRuleLimit: chrome.declarativeNetRequest.MAX_NUMBER_OF_SESSION_RULES ?? 5000
  };
}

function countOwnedRules(rules, minId, maxId) {
  return (rules || []).filter((rule) => rule.id >= minId && rule.id <= maxId).length;
}

async function getDraftSitePolicies() {
  const { draftSitePolicies = {} } = await draftStore.get(["draftSitePolicies"]);
  return draftSitePolicies || {};
}

/*
 * Refuses to persist a policy write that would leave two committed cells
 * both beyond the specificity depth cap, in an ancestor/descendant
 * relationship, disagreeing on action - the one case Chrome's own
 * "highest priority wins" evaluator cannot resolve by specificity, so VIGIL
 * must not let its equal-priority tiebreak decide silently. This gate lives
 * at the write boundary (commit / import / rules-text apply), not inside the
 * compiler: compileCommittedRules must stay non-throwing so a conflict
 * already present in stored policy (e.g. from before this check existed)
 * never blocks bootstrap from applying enforcement on browser startup.
 */
async function assertNoSpecificityConflicts({ sitePolicies, globalPolicy }) {
  const suffixes = await loadSuffixes();
  const conflicts = findSpecificityConflicts({ sitePolicies, globalPolicy, suffixes });
  if (!conflicts.length) return;
  const detail = conflicts
    .map(({ a, b }) => `[${a.scope} → ${a.target} (${a.matrixType}): ${a.action}] vs [${b.scope} → ${b.target} (${b.matrixType}): ${b.action}]`)
    .join("; ");
  throw new Error(
    `Cannot save: ${conflicts.length} nested hostname/target pair(s) are both more than ${MAX_NESTING_DEPTH} labels deep and disagree on action, so VIGIL cannot order them by specificity. Change one side to match the other. ${detail}`
  );
}

/* ------------------------------------------------------------------ *
 * Draft / commit / revert / clear
 *
 * "Site" here means any non-global scope key: a registrable domain OR a
 * full hostname (v0.9 hostname scopes reuse the same storage and messages).
 * ------------------------------------------------------------------ */

async function applyDraftSitePolicy(payload) {
  const { sourceDomain, sitePolicy } = payload || {};
  validateDomain(sourceDomain, "sourceDomain");
  validateTargetPolicy(sitePolicy || {});

  const draftSitePolicies = await getDraftSitePolicies();
  if (!sitePolicy || isEmptyTargetPolicy(sitePolicy)) {
    // An empty draft is still a draft ("clear everything in this scope"),
    // unless it equals the committed policy, in which case drop it.
    const { sitePolicies = {} } = await chrome.storage.local.get(["sitePolicies"]);
    if (isEmptyTargetPolicy(sitePolicies[sourceDomain] || {})) delete draftSitePolicies[sourceDomain];
    else draftSitePolicies[sourceDomain] = {};
  } else {
    draftSitePolicies[sourceDomain] = sitePolicy;
  }

  await draftStore.set({ draftSitePolicies });
  const compiled = await compileAndApplySessionRules();
  return { ok: true, draftSitePolicies, compiled };
}

async function applyDraftGlobalPolicy(payload) {
  const { globalPolicy } = payload || {};
  validateTargetPolicy(globalPolicy || {});
  await draftStore.set({ draftGlobalPolicy: globalPolicy || {} });
  const compiled = await compileAndApplySessionRules();
  return { ok: true, draftGlobalPolicy: globalPolicy || {}, compiled };
}

async function commitSitePolicy(payload) {
  const { sourceDomain, sitePolicy } = payload || {};
  validateDomain(sourceDomain, "sourceDomain");
  validateTargetPolicy(sitePolicy || {});

  const { sitePolicies = {}, globalPolicy = {} } = await chrome.storage.local.get(["sitePolicies", "globalPolicy"]);
  if (!sitePolicy || isEmptyTargetPolicy(sitePolicy)) delete sitePolicies[sourceDomain];
  else sitePolicies[sourceDomain] = sitePolicy;

  await assertNoSpecificityConflicts({ sitePolicies, globalPolicy });
  await chrome.storage.local.set({ sitePolicies });

  const draftSitePolicies = await getDraftSitePolicies();
  delete draftSitePolicies[sourceDomain];
  await draftStore.set({ draftSitePolicies });

  const dynamic = await compileAndApplyDynamicRules();
  const session = await compileAndApplySessionRules();
  return { ok: true, sitePolicies, dynamic, session };
}

async function commitGlobalPolicy(payload) {
  const { globalPolicy } = payload || {};
  validateTargetPolicy(globalPolicy || {});

  const { sitePolicies = {} } = await chrome.storage.local.get(["sitePolicies"]);
  await assertNoSpecificityConflicts({ sitePolicies, globalPolicy: globalPolicy || {} });

  await chrome.storage.local.set({ globalPolicy: globalPolicy || {} });
  await draftStore.set({ draftGlobalPolicy: null });

  const dynamic = await compileAndApplyDynamicRules();
  const session = await compileAndApplySessionRules();
  return { ok: true, globalPolicy: globalPolicy || {}, dynamic, session };
}

async function revertSitePolicy(payload) {
  const { sourceDomain } = payload || {};
  validateDomain(sourceDomain, "sourceDomain");
  const draftSitePolicies = await getDraftSitePolicies();
  delete draftSitePolicies[sourceDomain];
  await draftStore.set({ draftSitePolicies });
  const session = await compileAndApplySessionRules();
  return { ok: true, draftSitePolicies, session };
}

async function revertGlobalPolicy() {
  await draftStore.set({ draftGlobalPolicy: null });
  const session = await compileAndApplySessionRules();
  return { ok: true, draftGlobalPolicy: null, session };
}

async function clearSitePolicy(payload) {
  const { sourceDomain } = payload || {};
  validateDomain(sourceDomain, "sourceDomain");

  const { sitePolicies = {} } = await chrome.storage.local.get(["sitePolicies"]);
  delete sitePolicies[sourceDomain];
  await chrome.storage.local.set({ sitePolicies });

  const draftSitePolicies = await getDraftSitePolicies();
  delete draftSitePolicies[sourceDomain];
  await draftStore.set({ draftSitePolicies });

  const dynamic = await compileAndApplyDynamicRules();
  const session = await compileAndApplySessionRules();
  return { ok: true, sitePolicies, dynamic, session };
}

async function clearGlobalPolicy() {
  await chrome.storage.local.set({ globalPolicy: {} });
  await draftStore.set({ draftGlobalPolicy: null });
  const dynamic = await compileAndApplyDynamicRules();
  const session = await compileAndApplySessionRules();
  return { ok: true, globalPolicy: {}, dynamic, session };
}

/* ------------------------------------------------------------------ *
 * Settings, switches, blocklist & trust
 * ------------------------------------------------------------------ */

async function setSettings(payload) {
  const patch = payload?.settings || {};
  const { settings = {} } = await chrome.storage.local.get(["settings"]);
  const next = { ...settings, ...patch, schemaVersion: SCHEMA_VERSION };
  next.defaultDeny = Boolean(next.defaultDeny);
  next.blocklistEnabled = Boolean(next.blocklistEnabled);
  await chrome.storage.local.set({ settings: next });
  // defaultDeny changes both the dynamic rule set (deny-all base rule) AND
  // the session rule set (draft-noop neutralizers resolve differently).
  const dynamic = await compileAndApplyDynamicRules();
  const session = await compileAndApplySessionRules();
  return { ok: true, settings: next, dynamic, session };
}

/*
 * Switches are committed immediately (no draft layer): they are per-scope
 * toggles like uMatrix's blue puzzle switches, not matrix experiments.
 */
async function setSwitch(payload) {
  const { scope, name, on } = payload || {};
  validateScope(scope, "switch scope");
  if (!SWITCH_NAMES.includes(name)) throw new Error(`Unknown switch: ${name}`);

  const { switches = {} } = await chrome.storage.local.get(["switches"]);
  if (on) {
    switches[scope] ||= {};
    switches[scope][name] = true;
  } else if (switches[scope]) {
    delete switches[scope][name];
    if (Object.keys(switches[scope]).length === 0) delete switches[scope];
  }
  validateSwitches(switches);
  await chrome.storage.local.set({ switches });

  const dynamic = await compileAndApplyDynamicRules();
  return { ok: true, switches, dynamic };
}

/*
 * The static blocklist ruleset ships with the extension (see
 * tools/build-blocklist.mjs) and does not count against the dynamic quota.
 * Its rules use priority 5, so any explicit allow cell overrides them.
 */
async function setBlocklist(payload) {
  const enabled = Boolean(payload?.enabled);
  const { settings = {} } = await chrome.storage.local.get(["settings"]);
  await chrome.storage.local.set({ settings: { ...settings, blocklistEnabled: enabled, schemaVersion: SCHEMA_VERSION } });
  await applyBlocklistSetting();
  return { ok: true, blocklistEnabled: enabled };
}

async function applyBlocklistSetting() {
  const { settings = {} } = await chrome.storage.local.get(["settings"]);
  const want = Boolean(settings.blocklistEnabled);
  try {
    const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
    const has = enabled.includes(BLOCKLIST_RULESET_ID);
    if (want && !has) {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [BLOCKLIST_RULESET_ID] });
    } else if (!want && has) {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: [BLOCKLIST_RULESET_ID] });
    }
  } catch (error) {
    // Non-fatal: the manifest may ship without the ruleset in dev builds.
    console.warn("VIGIL: blocklist ruleset toggle failed:", error);
  }
}

async function setTrustedSite(payload) {
  const { sourceDomain, trusted } = payload || {};
  validateDomain(sourceDomain, "sourceDomain");
  const { trustedSites = [] } = await draftStore.get(["trustedSites"]);
  const set = new Set(trustedSites);
  if (trusted) set.add(sourceDomain);
  else set.delete(sourceDomain);
  const next = Array.from(set).sort();
  await draftStore.set({ trustedSites: next });
  const session = await compileAndApplySessionRules();
  return { ok: true, trustedSites: next, session };
}

/* ------------------------------------------------------------------ *
 * Observed-domain history
 *
 * Persisting scans means domains stay in the matrix after being blocked,
 * so users can still find and un-block them (MV3 page scans cannot see
 * requests that DNR already blocked). v0.9 stores more raw hostnames per
 * target to feed the hostname-hierarchy rows in the popup.
 * ------------------------------------------------------------------ */

async function recordScan(payload) {
  const { sourceDomain, targets } = payload || {};
  validateDomain(sourceDomain, "sourceDomain");
  const now = Date.now();

  const { observedDomains = {} } = await chrome.storage.local.get(["observedDomains"]);
  const site = observedDomains[sourceDomain] || { updatedAt: now, targets: {} };
  site.updatedAt = now;

  for (const t of targets || []) {
    if (!isValidAsciiDomain(t?.targetDomain)) continue;
    if (!MATRIX_TYPES.includes(t?.matrixType) || t.matrixType === "cookie") continue;
    const entry = site.targets[t.targetDomain] || { lastSeen: now, types: {}, rawHosts: [] };
    entry.lastSeen = now;
    entry.types[t.matrixType] = (entry.types[t.matrixType] || 0) + (Number(t.count) || 0);
    const rawHost = String(t.rawHost || "").toLowerCase();
    if (rawHost && isValidAsciiDomain(rawHost) && !entry.rawHosts.includes(rawHost) && entry.rawHosts.length < OBSERVED_MAX_RAW_HOSTS) {
      entry.rawHosts.push(rawHost);
    }
    site.targets[t.targetDomain] = entry;
  }

  // Prune targets per site (oldest first).
  const targetEntries = Object.entries(site.targets);
  if (targetEntries.length > OBSERVED_MAX_TARGETS_PER_SITE) {
    targetEntries.sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0));
    site.targets = Object.fromEntries(targetEntries.slice(0, OBSERVED_MAX_TARGETS_PER_SITE));
  }
  observedDomains[sourceDomain] = site;

  // Prune sites: TTL, then cap.
  for (const [key, value] of Object.entries(observedDomains)) {
    if (now - (value.updatedAt || 0) > OBSERVED_TTL_MS) delete observedDomains[key];
  }
  const siteEntries = Object.entries(observedDomains);
  if (siteEntries.length > OBSERVED_MAX_SITES) {
    siteEntries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
    for (const [key] of siteEntries.slice(OBSERVED_MAX_SITES)) delete observedDomains[key];
  }

  await chrome.storage.local.set({ observedDomains });
  return { ok: true, siteHistory: observedDomains[sourceDomain] || { targets: {} } };
}

/* ------------------------------------------------------------------ *
 * Compile & apply
 * ------------------------------------------------------------------ */

async function compileAllRules() {
  const dynamic = await compileAndApplyDynamicRules();
  const session = await compileAndApplySessionRules();
  return { ok: true, dynamic, session };
}

async function compileAndApplyDynamicRules() {
  await ensureDefaultState();
  const suffixes = await loadSuffixes();
  const { sitePolicies = {}, globalPolicy = {}, switches = {}, settings = {} } =
    await chrome.storage.local.get(["sitePolicies", "globalPolicy", "switches", "settings"]);

  const addRules = compileCommittedRules({
    sitePolicies,
    globalPolicy,
    switches,
    defaultDeny: Boolean(settings.defaultDeny),
    suffixes
  });

  await assertQuota(addRules.length, "dynamic");

  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = currentRules
    .filter((rule) => rule.id >= DYNAMIC_RULE_BASE_ID && rule.id <= DYNAMIC_RULE_MAX_ID)
    .map((rule) => rule.id);

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  await storeRuleSnapshot("dynamic", addRules);
  return { ok: true, added: addRules.length, removed: removeRuleIds.length };
}

async function compileAndApplySessionRules() {
  await ensureDefaultState();
  const suffixes = await loadSuffixes();
  const { sitePolicies = {}, globalPolicy = {}, settings = {} } =
    await chrome.storage.local.get(["sitePolicies", "globalPolicy", "settings"]);
  const { draftSitePolicies = {}, draftGlobalPolicy = null, trustedSites = [] } =
    await draftStore.get(["draftSitePolicies", "draftGlobalPolicy", "trustedSites"]);

  const addRules = compileSessionRules({
    committedSitePolicies: sitePolicies,
    committedGlobalPolicy: globalPolicy,
    draftSitePolicies: draftSitePolicies || {},
    draftGlobalPolicy,
    trustedSites,
    defaultDeny: Boolean(settings.defaultDeny),
    suffixes
  });

  await assertQuota(addRules.length, "session");

  const currentRules = await chrome.declarativeNetRequest.getSessionRules();
  const removeRuleIds = currentRules
    .filter((rule) => rule.id >= SESSION_RULE_BASE_ID && rule.id <= SESSION_RULE_MAX_ID)
    .map((rule) => rule.id);

  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
  await storeRuleSnapshot("session", addRules);
  return { ok: true, added: addRules.length, removed: removeRuleIds.length };
}

async function assertQuota(count, kind) {
  const limit = kind === "dynamic"
    ? (chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES ?? 30000)
    : (chrome.declarativeNetRequest.MAX_NUMBER_OF_SESSION_RULES ?? 5000);
  if (count > limit) {
    throw new Error(`Compiled ${count} ${kind} rules but the browser limit is ${limit}. Reduce or consolidate policy.`);
  }
}

/* ------------------------------------------------------------------ *
 * Rule snapshots for stable matched-rule attribution
 *
 * Rules are renumbered on every compile. A match reported by
 * getMatchedRules may predate the latest compile, so we resolve each match
 * against the snapshot that was live at the match timestamp.
 * ------------------------------------------------------------------ */

function describeHeaders(action) {
  // Distinguish cookie stripping / referrer stripping / CSP injection in
  // the matched-rules viewer without storing whole actions.
  const names = [];
  for (const h of action?.requestHeaders || []) names.push(h.header.toLowerCase());
  for (const h of action?.responseHeaders || []) names.push(h.header.toLowerCase());
  return names;
}

async function storeRuleSnapshot(store, rules) {
  const key = "ruleSnapshots";
  const { [key]: snapshots = { dynamic: [], session: [] } } = await draftStore.get([key]);
  const list = snapshots[store] || [];
  list.push({
    ts: Date.now(),
    rules: rules.map((r) => ({
      id: r.id,
      priority: r.priority,
      action: r.action?.type,
      headers: describeHeaders(r.action),
      initiatorDomains: r.condition?.initiatorDomains || [],
      requestDomains: r.condition?.requestDomains || [],
      resourceTypes: r.condition?.resourceTypes || []
    }))
  });
  snapshots[store] = list.slice(-SNAPSHOT_HISTORY);
  await draftStore.set({ [key]: snapshots });
}

function resolveMatch(snapshots, currentIndex, info) {
  const ts = info.timeStamp || Date.now();
  for (const store of ["session", "dynamic"]) {
    const list = (snapshots?.[store] || []).filter((s) => s.ts <= ts);
    for (let i = list.length - 1; i >= 0; i--) {
      const rule = list[i].rules.find((r) => r.id === info.ruleId);
      if (rule) return { store: store === "session" ? "temporary" : "saved", rule };
    }
  }
  return currentIndex.get(info.ruleId) || null;
}

async function getMatchedRules(payload) {
  const tabId = Number(payload?.tabId);
  if (!Number.isInteger(tabId)) throw new Error("tabId is required");

  let details = null;
  try {
    details = await chrome.declarativeNetRequest.getMatchedRules({ tabId });
  } catch (error) {
    return {
      ok: true,
      matches: [],
      warning: `${String(error?.message || error)} — note: getMatchedRules is quota-limited by the browser (about 20 calls per 10 minutes outside the active tab).`
    };
  }

  const dynamicRules = await chrome.declarativeNetRequest.getDynamicRules();
  const sessionRules = await chrome.declarativeNetRequest.getSessionRules();
  const currentIndex = new Map();
  for (const rule of dynamicRules || []) currentIndex.set(rule.id, describeCurrent("saved", rule));
  for (const rule of sessionRules || []) currentIndex.set(rule.id, describeCurrent("temporary", rule));

  const { ruleSnapshots = { dynamic: [], session: [] } } = await draftStore.get(["ruleSnapshots"]);

  const matches = (details?.rulesMatchedInfo || [])
    .map((info) => ({ info, resolved: resolveMatch(ruleSnapshots, currentIndex, info) }))
    .filter(({ resolved }) => resolved)
    .map(({ info, resolved }) => ({
      ruleId: info.ruleId,
      timeStamp: info.timeStamp,
      tabId: info.tabId,
      store: resolved.store,
      action: resolved.rule.action,
      headers: resolved.rule.headers || [],
      priority: resolved.rule.priority,
      scope: resolved.rule.initiatorDomains?.length ? "site" : "global",
      sourceDomains: resolved.rule.initiatorDomains || [],
      requestDomains: resolved.rule.requestDomains || [],
      resourceTypes: resolved.rule.resourceTypes || []
    }))
    .sort((a, b) => (b.timeStamp || 0) - (a.timeStamp || 0));

  return { ok: true, matches };
}

function describeCurrent(store, rule) {
  return {
    store,
    rule: {
      id: rule.id,
      priority: rule.priority,
      action: rule.action?.type,
      headers: describeHeaders(rule.action),
      initiatorDomains: rule.condition?.initiatorDomains || [],
      requestDomains: rule.condition?.requestDomains || [],
      resourceTypes: rule.condition?.resourceTypes || []
    }
  };
}

/* ------------------------------------------------------------------ *
 * Import / export / rules-text apply
 * ------------------------------------------------------------------ */

async function exportState() {
  await ensureDefaultState();
  const { sitePolicies = {}, globalPolicy = {}, switches = {}, settings = {} } =
    await chrome.storage.local.get(["sitePolicies", "globalPolicy", "switches", "settings"]);
  return {
    ok: true,
    export: {
      name: "VIGIL Matrix Lite policy export",
      exportedAt: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
      globalPolicy,
      sitePolicies,
      switches,
      settings: { ...settings, normalizeToRegistrableDomain: "psl-lite", schemaVersion: SCHEMA_VERSION }
    }
  };
}

async function importState(payload) {
  const imported = payload?.import;
  if (!imported || typeof imported !== "object") throw new Error("Missing import payload");
  if (![1, 2, 3, 4, 5, 6, 7].includes(imported.schemaVersion)) {
    throw new Error(`Unsupported schemaVersion: ${imported.schemaVersion}`);
  }

  const rawSitePolicies = imported.sitePolicies || imported.policies || {};
  const rawGlobalPolicy = imported.globalPolicy || {};

  // Normalize IDN keys to punycode instead of rejecting them.
  const sitePolicies = {};
  for (const [source, policy] of Object.entries(rawSitePolicies)) {
    sitePolicies[toAsciiDomain(source)] = normalizeTargetPolicyDomains(policy);
  }
  const globalPolicy = normalizeTargetPolicyDomains(rawGlobalPolicy);
  const switches = imported.switches || {};

  validateSitePolicies(sitePolicies);
  validateTargetPolicy(globalPolicy);
  validateSwitches(switches);
  await assertNoSpecificityConflicts({ sitePolicies, globalPolicy });

  const { settings = {} } = await chrome.storage.local.get(["settings"]);
  await chrome.storage.local.set({
    sitePolicies,
    globalPolicy,
    switches,
    settings: {
      ...settings,
      ...(imported.settings || {}),
      defaultDeny: Boolean(imported.settings?.defaultDeny ?? settings.defaultDeny ?? false),
      blocklistEnabled: Boolean(imported.settings?.blocklistEnabled ?? settings.blocklistEnabled ?? false),
      schemaVersion: SCHEMA_VERSION
    }
  });
  await draftStore.set({ draftSitePolicies: {}, draftGlobalPolicy: null });

  await applyBlocklistSetting();
  const dynamic = await compileAndApplyDynamicRules();
  const session = await compileAndApplySessionRules();
  return { ok: true, dynamic, session };
}

/*
 * Apply a parsed "My rules" text state (options page parses & diffs with
 * src/lib/rulesText.js). Replaces the committed policy and switches;
 * settings are patched only for keys the text explicitly set.
 */
async function applyRulesText(payload) {
  const { sitePolicies = {}, globalPolicy = {}, switches = {}, settings: settingsPatch = {} } = payload || {};
  validateSitePolicies(sitePolicies);
  validateTargetPolicy(globalPolicy);
  validateSwitches(switches);
  await assertNoSpecificityConflicts({ sitePolicies, globalPolicy });

  const { settings = {} } = await chrome.storage.local.get(["settings"]);
  const next = { ...settings, schemaVersion: SCHEMA_VERSION };
  if (typeof settingsPatch.defaultDeny === "boolean") next.defaultDeny = settingsPatch.defaultDeny;
  if (typeof settingsPatch.blocklistEnabled === "boolean") next.blocklistEnabled = settingsPatch.blocklistEnabled;

  await chrome.storage.local.set({ sitePolicies, globalPolicy, switches, settings: next });
  await draftStore.set({ draftSitePolicies: {}, draftGlobalPolicy: null });

  await applyBlocklistSetting();
  const dynamic = await compileAndApplyDynamicRules();
  const session = await compileAndApplySessionRules();
  return { ok: true, dynamic, session };
}

function normalizeTargetPolicyDomains(targetPolicy) {
  const out = {};
  for (const [target, typePolicies] of Object.entries(targetPolicy || {})) {
    const ascii = target === "*" ? "*" : toAsciiDomain(target);
    out[ascii] = {};
    for (const [matrixType, action] of Object.entries(typePolicies || {})) {
      validateMatrixType(matrixType);
      validateAction(matrixType, action, false);
      out[ascii][matrixType] = action;
    }
  }
  return out;
}
