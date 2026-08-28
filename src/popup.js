/*
 * VIGIL Matrix Lite - popup / side panel UI (v0.9, ES module)
 *
 * v0.9 changes vs v0.8:
 * - Three scope levels: global "*", registrable domain, full hostname
 *   (host button hidden when the page host IS the registrable domain).
 * - Hostname hierarchy: rows are grouped per registrable domain with
 *   collapsible, indented hostname sub-rows; cells can target either the
 *   whole domain or a single hostname (more specific target wins).
 * - The header row IS the "*" row: column header cells cycle the
 *   ("*", type) cell, the top-left header cycles ("*", "*"), and every row
 *   has a leading "All" cell for its (target, "*") coordinate.
 * - Per-scope switch chips (matrix-off, no-inline-script, no-worker,
 *   strip-referrer, https-upgrade), committed immediately via SET_SWITCH.
 * - Inherited cell display now uses the compiler's own resolveOutcome so
 *   the preview exactly matches the compiled DNR priority ladder.
 */
import { canonicalHost, registrableDomain as pslRegistrableDomain } from "./lib/domains.js";
import {
  GLOBAL_SCOPE, TARGET_WILDCARD, TYPE_WILDCARD, SWITCH_NAMES, PRIORITY,
  resolveOutcome, scopeChainFor
} from "./lib/dnrCompiler.js";

// Leading "All" column = the type-"*" cell of each row.
const RESOURCE_COLUMNS = [
  [TYPE_WILDCARD, "All"],
  ["cookie", "Cookie"],
  ["stylesheet", "CSS"],
  ["font", "Font"],
  ["image", "Image"],
  ["media", "Media"],
  ["script", "Script"],
  ["xmlhttprequest", "XHR+"],
  ["sub_frame", "Frame"]
];

const OBSERVABLE_TYPES = new Set(["script", "xmlhttprequest", "sub_frame", "image", "stylesheet", "font", "media"]);
const HIGH_RISK_DEFAULT_TYPES = new Set(["script", "xmlhttprequest", "sub_frame", "cookie"]);

const SWITCH_LABELS = {
  "matrix-off": "Matrix off",
  "no-inline-script": "No inline scripts",
  "no-worker": "No workers",
  "strip-referrer": "Strip referrer",
  "https-upgrade": "HTTPS upgrade",
  "strip-tracking-params": "Strip tracking params"
};
const SWITCH_HINTS = {
  "matrix-off": "Persistent kill switch: the whole frame tree of this scope bypasses every VIGIL rule.",
  "no-inline-script": "Injects a CSP header that blocks inline <script> and inline event handlers. Turn on to allowlist specific inline scripts by content hash below.",
  "no-worker": "Injects a CSP header (worker-src 'none') that blocks Web/Shared/Service workers.",
  "strip-referrer": "Removes the Referer header from requests in this scope.",
  "https-upgrade": "Upgrades http:// requests in this scope to https://.",
  "strip-tracking-params": "Drops known click/campaign query params (utm_*, fbclid, gclid, ...) from navigation URLs in this scope."
};

const DEFAULT_CLASSIFICATION = {
  registrableDomainSuffixes: ["co.uk", "org.uk", "com.au", "com.br", "co.nz", "co.jp", "co.in", "github.io", "pages.dev", "web.app"],
  trackerDomains: [
    "doubleclick.net", "googlesyndication.com", "google-analytics.com", "analytics.google.com",
    "googletagmanager.com", "adservice.google.com", "facebook.net", "connect.facebook.net",
    "scorecardresearch.com", "quantserve.com", "hotjar.com", "clarity.ms", "segment.com",
    "segment.io", "mixpanel.com", "criteo.com", "taboola.com", "outbrain.com", "adsrvr.org",
    "pubmatic.com", "rubiconproject.com", "mathtag.com", "demdex.net", "omtrdc.net", "newrelic.com", "sentry.io"
  ],
  coreHostHints: ["www", "static", "assets", "cdn", "img", "images", "media", "fonts", "api", "app", "login", "auth", "sso"],
  // Subdomain labels commonly used by first-party-disguised tracking
  // infrastructure (CNAME cloaking): a subdomain of the site you're on that
  // matches one of these is flagged as a possible cloaked tracker rather
  // than trusted as same-site by default. Local heuristic only - no DNS
  // resolution, which Chromium extensions cannot do at all (see
  // conversation/roadmap notes on CNAME cloaking). Expect false positives
  // and false negatives; this is a nudge to go verify, not a verdict.
  trackingHostHints: [
    "analytics", "track", "tracking", "trk",
    "metrics", "metric", "telemetry",
    "pixel", "pixels", "beacon", "beacons",
    "collect", "collector", "stats", "stat",
    "tag", "tags", "insight", "insights",
    "events", "event", "log", "logs",
    "click", "clicks", "adserver", "ads"
  ],
  policyPacks: {}
};

let currentTab = null;
let scan = null;
let siteHistory = { targets: {} };
let state = null;
let classification = DEFAULT_CLASSIFICATION;
let suffixSet = new Set(DEFAULT_CLASSIFICATION.registrableDomainSuffixes);
let workingPolicy = {};
let rawSourceDomain = null;   // full page hostname, e.g. app.example.com
let sourceDomain = null;      // registrable domain, e.g. example.com
let scopeMode = "domain";     // "global" | "domain" | "host"
let matchesOpen = false;
let isSidePanel = false;
let legendOpen = false;
let onlyObserved = false;
const expandedGroups = new Set(); // registrable domains with hostname rows shown

const $ = (id) => document.getElementById(id);

/*
 * popup.html is reused verbatim as the side_panel default_path (manifest.json),
 * so the only way to tell them apart at runtime is to ask the extension API
 * which surface this document is. A window open as an action popup shows up
 * in chrome.extension.getViews({type:"popup"}); the side panel never does.
 */
function detectSidePanel() {
  try {
    const popups = chrome.extension?.getViews?.({ type: "popup" }) || [];
    return !popups.includes(window);
  } catch (_) {
    return false;
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  isSidePanel = detectSidePanel();
  document.body.classList.toggle("sidepanel", isSidePanel);

  legendOpen = sessionStorage.getItem("vigil-legend-open") === "1";
  setLegendOpen(legendOpen);

  $("refresh").addEventListener("click", load);
  $("scopeGlobal").addEventListener("click", () => switchScope("global"));
  $("scopeDomain").addEventListener("click", () => switchScope("domain"));
  $("scopeHost").addEventListener("click", () => switchScope("host"));
  $("saveScope").addEventListener("click", guard(saveScopePolicy));
  $("revertScope").addEventListener("click", guard(revertScopePolicy));
  $("clearScope").addEventListener("click", guard(clearWorkingPolicy));
  $("blockThirdPartyScripts").addEventListener("click", guard(() => bulkBlock("script")));
  $("blockThirdPartyFrames").addEventListener("click", guard(() => bulkBlock("sub_frame")));
  $("applySuggestedBlocks").addEventListener("click", guard(applySuggestedBlocks));
  $("applyPolicyPack").addEventListener("click", guard(applySelectedPolicyPack));
  $("onlyObserved").addEventListener("click", () => {
    onlyObserved = !onlyObserved;
    render();
  });
  $("trustSite").addEventListener("click", guard(toggleTrustSite));
  $("showMatches").addEventListener("click", guard(toggleMatchedRules));
  $("exportPolicy").addEventListener("click", guard(exportPolicy));
  $("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("openSidePanel").addEventListener("click", guard(openSidePanel));
  $("legendToggle").addEventListener("click", () => setLegendOpen(!legendOpen));
  $("openSidePanelHint").addEventListener("click", (event) => {
    event.preventDefault();
    guard(openSidePanel)();
  });
  await load();
});

function setLegendOpen(open) {
  legendOpen = open;
  $("legendPanel").hidden = !open;
  $("legendToggle").setAttribute("aria-expanded", String(open));
  sessionStorage.setItem("vigil-legend-open", open ? "1" : "0");
}

function guard(fn) {
  return () => Promise.resolve(fn()).catch((error) => renderError(String(error?.message || error)));
}

async function load() {
  try {
    setBusy("Scanning current tab…");
    $("matches").hidden = true;
    matchesOpen = false;
    classification = await loadClassification();
    suffixSet = new Set(classification.registrableDomainSuffixes || DEFAULT_CLASSIFICATION.registrableDomainSuffixes);
    populatePolicyPackSelector();

    [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!currentTab?.id || !/^https?:/i.test(currentTab.url || "")) {
      renderError("Open an http(s) page, then open VIGIL Matrix Lite again.");
      return;
    }

    scan = await scanCurrentPage(currentTab.id);
    rawSourceDomain = canonicalHost(scan.sourceDomain);
    sourceDomain = registrableDomain(rawSourceDomain);
    if (scopeMode === "host" && rawSourceDomain === sourceDomain) scopeMode = "domain";

    siteHistory = await persistScan();
    state = await send({ type: "GET_STATE" });
    setWorkingPolicyFromState();
    render();
  } catch (error) {
    renderError(String(error?.message || error));
  }
}

async function loadClassification() {
  try {
    const response = await fetch(chrome.runtime.getURL("data/domain-classification.json"));
    if (!response.ok) throw new Error(`classification load failed: ${response.status}`);
    return { ...DEFAULT_CLASSIFICATION, ...(await response.json()) };
  } catch (_) {
    return DEFAULT_CLASSIFICATION;
  }
}

function populatePolicyPackSelector() {
  const select = $("policyPack");
  if (!select) return;
  const current = select.value || "balanced";
  const packs = classification.policyPacks || {};
  select.replaceChildren(...Object.entries(packs).map(([id, pack]) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = pack.label || id;
    return option;
  }));
  if (packs[current]) select.value = current;
  else if (packs.balanced) select.value = "balanced";
}

/* Scan every frame; third-party iframes load resources the top frame never sees. */
async function scanCurrentPage(tabId) {
  const injections = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["src/pageScan.js"]
  });

  const frames = (injections || []).map((i) => i.result).filter(Boolean);
  const top = frames.find((f) => f.isTop) || frames[0];
  if (!top) throw new Error("Page scan returned no results. Reload the page and retry.");

  const merged = new Map();
  for (const frame of frames) {
    for (const item of frame.resources || []) {
      const key = `${item.host}|${item.type}`;
      if (!merged.has(key)) merged.set(key, { host: item.host, type: item.type, count: 0, samples: [], sources: [] });
      const entry = merged.get(key);
      entry.count += item.count || 0;
      for (const s of item.samples || []) if (entry.samples.length < 3) entry.samples.push(s);
      for (const s of item.sources || []) if (!entry.sources.includes(s)) entry.sources.push(s);
    }
  }

  return {
    pageUrl: top.pageUrl,
    sourceDomain: top.frameHost,
    frameCount: frames.length,
    resources: Array.from(merged.values())
  };
}

async function persistScan() {
  // Persist several raw hosts per (target, type) so the hostname-hierarchy
  // rows survive in history after the resources get blocked.
  const grouped = groupResources(scan.resources);
  const targets = [];
  for (const [targetDomain, byType] of grouped.entries()) {
    for (const [matrixType, item] of Object.entries(byType)) {
      const rawHosts = Array.from(item.rawHosts || []);
      if (rawHosts.length === 0) rawHosts.push(targetDomain);
      rawHosts.slice(0, 6).forEach((rawHost, index) => {
        targets.push({ targetDomain, matrixType, count: index === 0 ? item.count : 0, rawHost });
      });
    }
  }
  const result = await send({ type: "RECORD_SCAN", payload: { sourceDomain, targets } });
  return result.siteHistory || { targets: {} };
}

/* ------------------------------------------------------------------ *
 * Scope handling
 * ------------------------------------------------------------------ */

function currentScopeKey() {
  if (scopeMode === "global") return GLOBAL_SCOPE;
  if (scopeMode === "host") return rawSourceDomain;
  return sourceDomain;
}

async function switchScope(nextScope) {
  if (!scan) return;
  scopeMode = nextScope;
  state = await send({ type: "GET_STATE" });
  setWorkingPolicyFromState();
  render();
}

function setWorkingPolicyFromState() {
  if (scopeMode === "global") {
    workingPolicy = clone(state.draftGlobalPolicy === null ? state.globalPolicy || {} : state.draftGlobalPolicy || {});
  } else {
    const key = currentScopeKey();
    workingPolicy = clone((state.draftSitePolicies || {})[key] ?? (state.sitePolicies || {})[key] ?? {});
  }
}

function getCommittedPolicy() {
  if (scopeMode === "global") return state.globalPolicy || {};
  return (state.sitePolicies || {})[currentScopeKey()] || {};
}

/*
 * Merged policy view over ALL scopes with drafts overlaid and the working
 * policy substituted for the scope being edited. Feeds resolveOutcome so
 * cell previews match the compiled priority ladder exactly.
 */
function mergedPoliciesView() {
  const view = {};
  view[GLOBAL_SCOPE] = scopeMode === "global"
    ? workingPolicy
    : (state.draftGlobalPolicy ?? state.globalPolicy ?? {});
  const scopeKeys = new Set([
    ...Object.keys(state.sitePolicies || {}),
    ...Object.keys(state.draftSitePolicies || {}),
    sourceDomain,
    rawSourceDomain
  ]);
  for (const key of scopeKeys) {
    if (!key) continue;
    view[key] = (state.draftSitePolicies || {})[key] ?? (state.sitePolicies || {})[key] ?? {};
  }
  if (scopeMode !== "global") view[currentScopeKey()] = workingPolicy;
  return view;
}

/* ------------------------------------------------------------------ *
 * Matrix model: registrable-domain groups with hostname sub-rows
 *
 * Sources per group:
 *  - hosts observed in the current scan (live counts, per raw hostname)
 *  - hosts/targets from the persisted observation history for this site
 *  - targets referenced by any policy visible from this page's scope chain
 * so blocked domains and hostname-targeted rules never vanish.
 * ------------------------------------------------------------------ */

function buildMatrixGroups() {
  const groups = new Map(); // registrable -> { aggregate, hosts: Map(rawHost -> byType), historical }

  const ensureGroup = (domain) => {
    if (!groups.has(domain)) groups.set(domain, { aggregate: {}, hosts: new Map(), historical: true });
    return groups.get(domain);
  };
  const bump = (byType, type, count, historicalCount) => {
    byType[type] ||= { count: 0, historicalCount: 0 };
    byType[type].count += count || 0;
    byType[type].historicalCount += historicalCount || 0;
  };

  // 1) Current scan: per raw host, aggregated per registrable domain.
  for (const item of scan.resources || []) {
    if (!OBSERVABLE_TYPES.has(item.type)) continue;
    const rawHost = canonicalHost(item.host);
    const domain = registrableDomain(rawHost);
    if (!domain) continue;
    const group = ensureGroup(domain);
    group.historical = false;
    bump(group.aggregate, item.type, item.count, 0);
    if (rawHost !== domain) {
      if (!group.hosts.has(rawHost)) group.hosts.set(rawHost, {});
      bump(group.hosts.get(rawHost), item.type, item.count, 0);
    }
  }

  // 2) History for this site.
  for (const [targetDomain, entry] of Object.entries(siteHistory?.targets || {})) {
    const group = ensureGroup(targetDomain);
    for (const [matrixType, count] of Object.entries(entry.types || {})) {
      bump(group.aggregate, matrixType, 0, count);
    }
    for (const rawHost of entry.rawHosts || []) {
      if (rawHost !== targetDomain && !group.hosts.has(rawHost)) group.hosts.set(rawHost, {});
    }
  }

  // 3) Policy targets visible from this page's scope chain: global plus this
  // site's own scopes only. mergedPoliciesView() carries every scope the
  // extension has EVER seen a policy for (across all sites), so it must be
  // walked through the actual chain here rather than iterated wholesale, or
  // an unrelated site's blocked domains would bleed into this page's matrix.
  const view = mergedPoliciesView();
  for (const scope of scopeChainFor(rawSourceDomain, suffixSet)) {
    const targetPolicy = view[scope];
    for (const target of Object.keys(targetPolicy || {})) {
      if (target === TARGET_WILDCARD) continue; // wildcard row = header row
      const domain = registrableDomain(target);
      if (!domain) continue;
      const group = ensureGroup(domain);
      if (target !== domain && !group.hosts.has(target)) group.hosts.set(target, {});
    }
  }

  return groups;
}

/* ------------------------------------------------------------------ *
 * Cell state helpers
 * ------------------------------------------------------------------ */

function workingPolicyFor(target, resourceType) {
  return workingPolicy[target]?.[resourceType] || "noop";
}

function committedPolicyFor(target, resourceType) {
  return getCommittedPolicy()[target]?.[resourceType] || "noop";
}

/*
 * Effective outcome for a cell as the page would experience it, using the
 * compiler's own resolver over the merged view (including the working
 * policy). Cookie cells are header rules and resolve separately.
 */
function defaultModeOf() {
  return state?.settings?.defaultMode || "open";
}

function effectiveOutcomeFor(target, resourceType) {
  if (resourceType === "cookie") return { action: null, coord: null };
  return resolveOutcome({
    contextHost: rawSourceDomain,
    target,
    matrixType: resourceType,
    policies: mergedPoliciesView(),
    suffixes: suffixSet,
    defaultMode: defaultModeOf()
  });
}

async function cycleCellPolicy(target, resourceType, currentPolicy) {
  // Cookie column is block-only: noop -> block -> noop.
  const next = resourceType === "cookie"
    ? (currentPolicy === "noop" ? "block" : "noop")
    : (currentPolicy === "noop" ? "block" : currentPolicy === "block" ? "allow" : "noop");
  setWorkingCellPolicy(target, resourceType, next);
  await applyDraft();
  render();
}

function setWorkingCellPolicy(target, resourceType, action) {
  workingPolicy[target] ||= {};
  if (action === "noop") {
    delete workingPolicy[target][resourceType];
    if (Object.keys(workingPolicy[target]).length === 0) delete workingPolicy[target];
  } else {
    workingPolicy[target][resourceType] = action;
  }
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

function scopeSwitches(scopeKey) {
  return (state.switches || {})[scopeKey] || {};
}

function activeSwitchCountForPage() {
  // Count switches active anywhere on this page's scope chain.
  let count = 0;
  for (const scopeKey of [rawSourceDomain, sourceDomain, GLOBAL_SCOPE]) {
    if (scopeKey === rawSourceDomain && rawSourceDomain === sourceDomain) continue;
    count += Object.values(scopeSwitches(scopeKey)).filter(Boolean).length;
  }
  return count;
}

function render() {
  const committedPolicy = getCommittedPolicy();
  const groups = buildMatrixGroups();
  const allDomains = Array.from(groups.keys()).sort(domainSort);
  const domains = onlyObserved ? allDomains.filter((d) => !groups.get(d).historical) : allDomains;
  const mode = defaultModeOf();

  const dirty = !deepEqual(workingPolicy, committedPolicy);
  const workingCells = countPolicyCells(workingPolicy);
  const committedCells = countPolicyCells(committedPolicy);
  const globalCells = countPolicyCells(state.globalPolicy || {});
  const scopeKey = currentScopeKey();
  const trusted = (state.trustedSites || []).includes(sourceDomain);
  const suggestedBlocks = countSuggestedBlockCells(groups);

  const dynLimit = state.dynamicRuleLimit || 30000;
  const sesLimit = state.sessionRuleLimit || 5000;
  const dynPct = Math.round((state.dynamicRuleCount / dynLimit) * 100);
  const quotaWarn = dynPct >= 80 || state.sessionRuleCount / sesLimit >= 0.8;

  const sourceNote = rawSourceDomain === sourceDomain ? sourceDomain : `${rawSourceDomain} → ${sourceDomain}`;
  $("site").textContent = onlyObserved
    ? `${sourceNote} — ${domains.length} of ${allDomains.length} resource domains (observed on this page only)`
    : `${sourceNote} — ${domains.length} resource domains (scan + history)`;
  $("summary").innerHTML = `
    <span>Saved DNR: <strong>${state.dynamicRuleCount}</strong>/${dynLimit}</span>
    <span>Temporary DNR: <strong>${state.sessionRuleCount}</strong>/${sesLimit}</span>
    <span>Global cells: <strong>${globalCells}</strong></span>
    <span>Scope <code>${escapeHtml(scopeKey)}</code>: <strong>${workingCells}</strong> working / <strong>${committedCells}</strong> saved</span>
    <span>Switches on page: <strong>${activeSwitchCountForPage()}</strong></span>
    ${state.blocklistEnabled ? `<span>blocklist ON</span>` : ""}
    ${mode !== "open" ? `<span class="warn">mode: ${escapeHtml(mode)}</span>` : ""}
    ${trusted ? `<span class="warn">site trusted (temp)</span>` : ""}
    ${quotaWarn ? `<span class="warn">rule quota ≥80%</span>` : ""}
    <span class="${dirty ? "pending" : "muted"}">${dirty ? "Unsaved changes" : "No pending changes"}</span>
  `;

  $("modeStatus").textContent = mode === "relaxed"
    ? "Mode: relaxed — 3P scripts/frames/XHR blocked, cookies stripped"
    : mode === "hard"
      ? "Mode: hard — everything blocked unless explicitly allowed"
      : "Mode: open — nothing blocked by default";

  // v0.12: the popup caps out at 800x600, so a big matrix is genuinely
  // cramped there — nudge toward the side panel instead of fighting it.
  $("sidePanelHint").hidden = isSidePanel || domains.length <= 25;

  $("scopeGlobal").classList.toggle("active", scopeMode === "global");
  $("scopeDomain").classList.toggle("active", scopeMode === "domain");
  $("scopeHost").classList.toggle("active", scopeMode === "host");
  $("scopeDomain").textContent = sourceDomain;
  $("scopeHost").textContent = rawSourceDomain;
  $("scopeHost").hidden = rawSourceDomain === sourceDomain;
  $("scopeHint").textContent = scopeMode === "global"
    ? "Global rules apply everywhere unless a more specific scope overrides them."
    : scopeMode === "domain"
      ? "Domain scope: rules for every page on this registrable domain. Hostname scope and more specific targets override."
      : "Hostname scope: rules for this exact host (and its subdomains). Overrides domain and global scopes.";

  $("saveScope").disabled = !dirty;
  $("revertScope").disabled = !dirty;
  $("saveScope").textContent = `Save ${scopeKey}`;
  $("revertScope").textContent = "Revert";
  $("clearScope").textContent = `Clear working ${scopeKey}`;
  $("applySuggestedBlocks").disabled = suggestedBlocks === 0;
  $("applySuggestedBlocks").textContent = suggestedBlocks === 0 ? "No suggested blocks" : `Apply suggested blocks (${suggestedBlocks})`;
  $("trustSite").hidden = scopeMode === "global";
  $("trustSite").textContent = trusted ? "Untrust site" : "Trust site (temp)";
  $("trustSite").title = "Temporary allowAllRequests for this site's frame tree. Bypasses all VIGIL rules until untrusted or browser restart. For a persistent version use the Matrix off switch.";

  $("onlyObserved").classList.toggle("active", onlyObserved);
  $("onlyObserved").textContent = onlyObserved ? "Only observed ✓" : "Only observed";

  renderSwitches(scopeKey);
  renderMatrixTable(groups, domains);
}

/* Switch chips for the current scope. Committed immediately on click. */
function renderSwitches(scopeKey) {
  const container = $("switches");
  const flags = scopeSwitches(scopeKey);
  container.replaceChildren();

  const label = document.createElement("span");
  label.className = "muted";
  label.textContent = `Switches for ${scopeKey}:`;
  container.appendChild(label);

  for (const name of SWITCH_NAMES) {
    const on = Boolean(flags[name]);
    const chip = document.createElement("button");
    chip.className = `switchChip${on ? " on" : ""}${name === "matrix-off" ? " danger" : ""}`;
    chip.textContent = `${SWITCH_LABELS[name]}: ${on ? "on" : "off"}`;
    chip.title = SWITCH_HINTS[name] + (name === "matrix-off" && scopeKey === GLOBAL_SCOPE
      ? " GLOBAL SCOPE: this disables VIGIL on every site!"
      : "");
    chip.addEventListener("click", guard(async () => {
      await send({ type: "SET_SWITCH", payload: { scope: scopeKey, name, on: !on } });
      state = await send({ type: "GET_STATE" });
      render();
    }));
    container.appendChild(chip);
  }

  // CSP hash allowlist only makes sense once no-inline-script is actually
  // on for this scope - it has nothing to attach to otherwise.
  if (flags["no-inline-script"]) container.appendChild(renderCspHashEditor(scopeKey));
}

/*
 * Per-scope inline-script hash allowlist for no-inline-script. Chrome's own
 * console error for a blocked inline script prints the exact 'sha256-...'
 * token to paste here - see cspNoInlineValue()'s doc comment for why nonces
 * aren't supported instead.
 */
function renderCspHashEditor(scopeKey) {
  const wrap = document.createElement("span");
  wrap.className = "cspHashEditor";

  const label = document.createElement("span");
  label.className = "muted";
  label.textContent = "Allowed inline-script hashes:";
  wrap.appendChild(label);

  const hashes = (state.cspAllowlist || {})[scopeKey] || [];
  for (const hash of hashes) {
    const chip = document.createElement("span");
    chip.className = "cspHashChip";
    chip.title = "Allowlisted inline-script hash for this scope";
    const text = document.createElement("span");
    text.className = "cspHashText";
    text.textContent = hash;
    chip.appendChild(text);
    const remove = document.createElement("button");
    remove.className = "cspHashRemove";
    remove.textContent = "×";
    remove.title = "Remove this hash";
    remove.addEventListener("click", guard(async () => {
      await send({ type: "SET_CSP_HASH", payload: { scope: scopeKey, hash, on: false } });
      state = await send({ type: "GET_STATE" });
      render();
    }));
    chip.appendChild(remove);
    wrap.appendChild(chip);
  }

  const input = document.createElement("input");
  input.type = "text";
  input.className = "cspHashInput";
  input.placeholder = "'sha256-...'";
  input.title = "Paste the 'sha256-...' / 'sha384-...' / 'sha512-...' token from Chrome's blocked-inline-script console error.";

  const addHash = guard(async () => {
    const hash = input.value.trim();
    if (!hash) return;
    await send({ type: "SET_CSP_HASH", payload: { scope: scopeKey, hash, on: true } });
    input.value = "";
    state = await send({ type: "GET_STATE" });
    render();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") addHash();
  });

  const addButton = document.createElement("button");
  addButton.textContent = "Add hash";
  addButton.addEventListener("click", addHash);

  wrap.appendChild(input);
  wrap.appendChild(addButton);
  return wrap;
}

function renderMatrixTable(groups, domains) {
  const table = document.createElement("table");

  // Fixed table-layout: the domain column gets an explicit width; the 9
  // resource columns have none, so the fixed-layout algorithm splits the
  // remaining space between them equally — this is what keeps the grid
  // inside ~800px without a horizontal scrollbar.
  const colgroup = document.createElement("colgroup");
  const domainCol = document.createElement("col");
  domainCol.className = "domainCol";
  colgroup.appendChild(domainCol);
  for (let i = 0; i < RESOURCE_COLUMNS.length; i++) colgroup.appendChild(document.createElement("col"));
  table.appendChild(colgroup);

  // Header row doubles as the "*" (all hosts) row, uMatrix-style: every
  // column header carries the cell button for ("*", type); the top-left
  // header carries ("*", "*").
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const cornerTh = document.createElement("th");
  cornerTh.className = "domainHead";
  cornerTh.appendChild(document.createTextNode("all hosts (*)"));
  headRow.appendChild(cornerTh);
  for (const [resourceType, label] of RESOURCE_COLUMNS) {
    const th = document.createElement("th");
    th.appendChild(document.createTextNode(label));
    th.appendChild(document.createElement("br"));
    // Header cells cycle the ("*", type) cell; the "All" header is ("*","*").
    th.appendChild(cellButton(TARGET_WILDCARD, resourceType, { observed: null, seen: true }));
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  if (domains.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = RESOURCE_COLUMNS.length + 1;
    td.className = "error";
    td.textContent = "No page resources detected. Reload the page and rescan.";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  for (const domain of domains) {
    const group = groups.get(domain);
    const hostNames = Array.from(group.hosts.keys()).sort();
    const expandable = hostNames.length > 0;
    const expanded = expandedGroups.has(domain);

    tbody.appendChild(matrixRow({
      target: domain,
      byType: group.aggregate,
      historical: group.historical,
      indent: false,
      expandable,
      expanded,
      hostCount: hostNames.length
    }));

    if (expandable && expanded) {
      for (const host of hostNames) {
        tbody.appendChild(matrixRow({
          target: host,
          byType: group.hosts.get(host),
          historical: group.historical,
          indent: true
        }));
      }
    }
  }
  table.appendChild(tbody);
  $("matrix").replaceChildren(table);
}

function matrixRow({ target, byType, historical, indent, expandable = false, expanded = false, hostCount = 0 }) {
  const row = document.createElement("tr");
  if (indent) row.className = "hostRow";
  const sameSite = isSameSite(target, sourceDomain);
  const tracker = isKnownTrackerDomain(target);
  // Only meaningful on hostname sub-rows: the top-level row's target is the
  // registrable domain itself, which looksLikeCloakedTracker() already
  // excludes (it's not a subdomain of anything).
  const cloak = indent && looksLikeCloakedTracker(target);
  const total = Object.values(byType || {}).reduce((acc, x) => acc + (x?.count || 0), 0);
  const historyTotal = Object.values(byType || {}).reduce((acc, x) => acc + (x?.historicalCount || 0), 0);

  const domainCell = document.createElement("td");
  domainCell.className = "domain";

  if (expandable) {
    const expander = document.createElement("button");
    expander.className = "expander";
    expander.textContent = expanded ? "▾" : "▸";
    expander.title = expanded ? "Hide hostname rows" : `Show ${hostCount} hostname row(s)`;
    expander.addEventListener("click", () => {
      if (expandedGroups.has(target)) expandedGroups.delete(target);
      else expandedGroups.add(target);
      render();
    });
    domainCell.appendChild(expander);
  } else if (!indent) {
    const spacer = document.createElement("span");
    spacer.className = "expanderSpacer";
    domainCell.appendChild(spacer);
  }

  const labelClass = cloak ? "cloakTracker" : tracker ? "trackerDomain" : sameSite ? "sameSite" : "thirdParty";
  const trustLabel = tracker ? "tracker/adtech candidate" : sameSite ? "same-site/core candidate" : "third-party";
  const countText = total > 0 ? `${total} observed` : historyTotal > 0 ? `history (${historyTotal})` : "policy/history only";
  const metaText = indent
    ? `${target} · ${countText}${cloak ? " · possible CNAME-cloaked tracker (naming heuristic, verify before blocking)" : ""}`
    : `${target} · ${trustLabel} · ${countText}${expandable ? ` · ${hostCount} host(s)` : ""}`;

  // v0.12: the old "third-party · N observed · N hosts" meta line moved
  // into this tooltip; only the count survives on-row, as a small badge.
  domainCell.title = metaText;

  const label = document.createElement("span");
  if (indent) {
    // Host rows truncate from the left (direction trick) so a long shared
    // suffix doesn't crowd out the part of the hostname nearest the arrow;
    // the full hostname is always available via the tooltip above.
    label.className = `${labelClass} hostLabel`;
    const arrow = document.createElement("span");
    arrow.className = "hostArrow";
    arrow.textContent = "↳ ";
    const hostText = document.createElement("span");
    hostText.className = "hostText";
    hostText.textContent = target;
    label.appendChild(arrow);
    label.appendChild(hostText);
  } else {
    label.className = `${labelClass} domainName`;
    label.textContent = target;
  }
  domainCell.appendChild(label);

  if (total > 0 || historyTotal > 0) {
    const badge = document.createElement("span");
    badge.className = "countBadge";
    badge.textContent = total > 0 ? String(total) : `h${historyTotal}`;
    domainCell.appendChild(badge);
  }
  row.appendChild(domainCell);

  for (const [resourceType] of RESOURCE_COLUMNS) {
    const observed = resourceType === TYPE_WILDCARD ? null : byType?.[resourceType];
    const seen = resourceType === TYPE_WILDCARD
      ? Object.keys(byType || {}).length > 0
      : resourceType === "cookie"
        ? Object.keys(byType || {}).length > 0 || !historical
        : Boolean(observed && (observed.count || observed.historicalCount));
    const td = document.createElement("td");
    td.appendChild(cellButton(target, resourceType, { observed, seen }));
    row.appendChild(td);
  }
  return row;
}

/* One matrix cell button: working state, inherited preview, suggestion. */
function cellButton(target, resourceType, { observed, seen }) {
  const working = workingPolicyFor(target, resourceType);
  const committed = committedPolicyFor(target, resourceType);
  const dirtyCell = working !== committed;
  const suggested = classifySuggestion({ target, resourceType });

  let displayAction = working;
  let inherited = false;
  let inheritedFrom = null;
  if (working === "noop" && resourceType !== "cookie") {
    const outcome = effectiveOutcomeFor(target, resourceType);
    // Surface an inherited badge for an explicit less-specific cell (has a
    // coord, any action) or for a default-mode block (no coord). A default
    // *allow* — open mode, or a relaxed first-party/allowed type — just means
    // "not blocked", so leave the cell as noop instead of painting it green.
    if (outcome.action && (outcome.coord || outcome.action === "block")) {
      displayAction = outcome.action;
      inherited = true;
      inheritedFrom = outcome.coord;
    }
  }

  const classes = ["cell"];
  if (!inherited && (working === "block" || working === "allow")) classes.push(working);
  else if (inherited) classes.push(displayAction, "inherited");
  else if (suggested === "suggestBlock") classes.push("suggestBlock");
  else if (suggested === "suggestCloak") classes.push("suggestCloak");
  else if (suggested === "suggestAllow") classes.push("suggestAllow");
  else classes.push("noop");
  if (!seen) classes.push("unseen");
  if (dirtyCell) classes.push("dirty");

  const btn = document.createElement("button");
  btn.className = "cellButton";
  btn.title = buildCellTitle({ target, resourceType, working, committed, inherited, inheritedFrom, suggested, observed });
  const span = document.createElement("span");
  span.className = classes.join(" ");
  btn.appendChild(span);
  btn.addEventListener("click", guard(() => cycleCellPolicy(target, resourceType, working)));
  return btn;
}

function buildCellTitle({ target, resourceType, working, committed, inherited, inheritedFrom, suggested, observed }) {
  const lines = [
    `${target} · ${resourceType === TYPE_WILDCARD ? "all types" : resourceType}`,
    `scope: ${currentScopeKey()}`,
    `working cell: ${working}`,
    `saved cell: ${committed}`
  ];
  if (inherited && inheritedFrom) {
    lines.push(`inherited ${resourceTypeLabel(inheritedFrom.matrixType)} ${effectiveWord(inheritedFrom)} from scope ${inheritedFrom.scope}, target ${inheritedFrom.target}`);
  } else if (inherited) {
    lines.push(`blocked by default (${defaultModeOf()} mode) — no matrix cell applies`);
  }
  if (resourceType === TYPE_WILDCARD) {
    lines.push('"All" cell: governs every request type except top navigation; specific type cells override it.');
  }
  if (resourceType === "cookie") {
    lines.push("cookie: strips Cookie / Set-Cookie headers (block-only column)");
    if (committed === "block" && working === "noop") {
      lines.push("note: removing a saved cookie block only takes effect after Save");
    }
  }
  if (suggested === "suggestBlock") lines.push("suggestion: known tracker — consider blocking");
  if (suggested === "suggestCloak") {
    lines.push("suggestion: same-site hostname, but its subdomain label matches a known tracking-infrastructure naming pattern (possible CNAME-cloaked tracker).");
    lines.push("this is a local naming heuristic, not a verdict — verify before blocking (Chromium extensions cannot resolve CNAMEs to check for real).");
  }
  if (suggested === "suggestAllow") lines.push("suggestion: same-site/core resource");
  if (observed) {
    if (observed.count) lines.push(`observed now: ${observed.count}`);
    if (observed.historicalCount) lines.push(`observed historically: ${observed.historicalCount}`);
  }
  return lines.join("\n");
}

function resourceTypeLabel(type) {
  return type === TYPE_WILDCARD ? "all-types" : type;
}
function effectiveWord(coord) {
  return coord ? "rule" : "default";
}

function domainSort(a, b) {
  if (isSameSite(a, sourceDomain) && !isSameSite(b, sourceDomain)) return -1;
  if (!isSameSite(a, sourceDomain) && isSameSite(b, sourceDomain)) return 1;
  if (isKnownTrackerDomain(a) && !isKnownTrackerDomain(b)) return 1;
  if (!isKnownTrackerDomain(a) && isKnownTrackerDomain(b)) return -1;
  return a.localeCompare(b);
}

/* ------------------------------------------------------------------ *
 * Grouping & suggestions
 * ------------------------------------------------------------------ */

function groupResources(resources) {
  const grouped = new Map();
  for (const item of resources || []) {
    if (!OBSERVABLE_TYPES.has(item.type)) continue;
    const rawHost = canonicalHost(item.host);
    const target = registrableDomain(rawHost);
    if (!target) continue;
    if (!grouped.has(target)) grouped.set(target, {});
    const bucket = grouped.get(target);
    if (!bucket[item.type]) bucket[item.type] = { host: target, type: item.type, count: 0, samples: [], rawHosts: new Set(), sources: new Set() };
    bucket[item.type].count += item.count || 0;
    bucket[item.type].rawHosts.add(rawHost);
    for (const source of item.sources || []) bucket[item.type].sources.add(source);
    for (const sample of item.samples || []) if (bucket[item.type].samples.length < 5) bucket[item.type].samples.push(sample);
  }
  return grouped;
}

function classifySuggestion({ target, resourceType }) {
  if (resourceType === TYPE_WILDCARD) return "neutral";
  if (isKnownTrackerDomain(target) && HIGH_RISK_DEFAULT_TYPES.has(resourceType)) return "suggestBlock";
  // Checked before the blanket same-site allow below: a cloak-flagged
  // target IS same-site by hostname, so it would otherwise fall into that
  // bucket and never get flagged.
  if (looksLikeCloakedTracker(target) && HIGH_RISK_DEFAULT_TYPES.has(resourceType)) return "suggestCloak";
  if (isSameSite(target, sourceDomain) && resourceType !== "cookie") return "suggestAllow";
  return "neutral";
}

function countSuggestedBlockCells(groups) {
  let count = 0;
  for (const [domain, group] of groups.entries()) {
    if (!isKnownTrackerDomain(domain)) continue;
    for (const [resourceType] of RESOURCE_COLUMNS) {
      if (!HIGH_RISK_DEFAULT_TYPES.has(resourceType)) continue;
      const seenOrCookie = resourceType === "cookie" ? Object.keys(group.aggregate).length > 0 : Boolean(group.aggregate[resourceType]);
      if (seenOrCookie && workingPolicy[domain]?.[resourceType] !== "block") count += 1;
    }
  }
  return count;
}

function countPolicyCells(policy) {
  let count = 0;
  for (const typePolicies of Object.values(policy || {})) count += Object.keys(typePolicies || {}).length;
  return count;
}

function isKnownTrackerDomain(host) {
  if (host === TARGET_WILDCARD) return false;
  const h = canonicalHost(host);
  const trackers = classification.trackerDomains || DEFAULT_CLASSIFICATION.trackerDomains;
  return trackers.some((pattern) => h === pattern || h.endsWith(`.${pattern}`));
}

function isSameSite(hostA, hostB) {
  if (hostA === TARGET_WILDCARD || hostB === TARGET_WILDCARD) return false;
  const a = registrableDomain(hostA);
  const b = registrableDomain(hostB);
  return a && b && a === b;
}

/*
 * CNAME-cloaking heuristic: a same-site subdomain (so it LOOKS first-party
 * by hostname, and would otherwise fall into the blanket same-site "trust
 * it" bucket below) whose own subdomain label matches a known
 * tracking-infrastructure naming convention. This cannot detect actual
 * cloaking - that requires resolving the CNAME chain, an API Chromium does
 * not expose to extensions at all (Firefox's uBlock Origin can do this via
 * browser.dns.resolve(); there is no equivalent here). It is purely a local
 * naming-pattern nudge to go verify a specific host, not a verdict - a
 * legitimate "stats.example.com" status page would false-positive here.
 * coreHostHints acts as a suppressor: an ordinary infra label wins over a
 * coincidental tracking-hint match on a different label in the same chain.
 */
function looksLikeCloakedTracker(target) {
  if (target === TARGET_WILDCARD) return false;
  if (!isSameSite(target, sourceDomain)) return false;
  const reg = registrableDomain(target);
  if (!reg || target === reg) return false; // the bare registrable domain itself, not a subdomain
  const subLabels = target.slice(0, target.length - reg.length - 1).split(".").filter(Boolean);
  const coreHints = classification.coreHostHints || DEFAULT_CLASSIFICATION.coreHostHints;
  if (subLabels.some((label) => coreHints.includes(label))) return false;
  const trackingHints = classification.trackingHostHints || DEFAULT_CLASSIFICATION.trackingHostHints;
  return subLabels.some((label) => trackingHints.includes(label));
}

function registrableDomain(host) {
  return pslRegistrableDomain(host, suffixSet);
}

/* ------------------------------------------------------------------ *
 * Draft / save / bulk actions
 * ------------------------------------------------------------------ */

async function applyDraft() {
  const message = scopeMode === "global"
    ? { type: "APPLY_DRAFT_GLOBAL_POLICY", payload: { globalPolicy: workingPolicy } }
    : { type: "APPLY_DRAFT_SITE_POLICY", payload: { sourceDomain: currentScopeKey(), sitePolicy: workingPolicy } };
  await send(message);
  state = await send({ type: "GET_STATE" });
}

async function saveScopePolicy() {
  const message = scopeMode === "global"
    ? { type: "COMMIT_GLOBAL_POLICY", payload: { globalPolicy: workingPolicy } }
    : { type: "COMMIT_SITE_POLICY", payload: { sourceDomain: currentScopeKey(), sitePolicy: workingPolicy } };
  await send(message);
  state = await send({ type: "GET_STATE" });
  setWorkingPolicyFromState();
  render();
}

async function revertScopePolicy() {
  const message = scopeMode === "global"
    ? { type: "REVERT_GLOBAL_POLICY" }
    : { type: "REVERT_SITE_POLICY", payload: { sourceDomain: currentScopeKey() } };
  await send(message);
  state = await send({ type: "GET_STATE" });
  setWorkingPolicyFromState();
  render();
}

async function clearWorkingPolicy() {
  workingPolicy = {};
  await applyDraft();
  render();
}

async function bulkBlock(resourceType) {
  const groups = buildMatrixGroups();
  for (const [domain, group] of groups.entries()) {
    if (isSameSite(domain, sourceDomain)) continue;
    if (!group.aggregate[resourceType]) continue;
    setWorkingCellPolicy(domain, resourceType, "block");
  }
  await applyDraft();
  render();
}

async function applySuggestedBlocks() {
  const groups = buildMatrixGroups();
  for (const [domain, group] of groups.entries()) {
    if (!isKnownTrackerDomain(domain)) continue;
    for (const [resourceType] of RESOURCE_COLUMNS) {
      if (!HIGH_RISK_DEFAULT_TYPES.has(resourceType)) continue;
      if (resourceType !== "cookie" && !group.aggregate[resourceType]) continue;
      setWorkingCellPolicy(domain, resourceType, "block");
    }
  }
  await applyDraft();
  render();
}

async function applySelectedPolicyPack() {
  const packId = $("policyPack")?.value || "balanced";
  const pack = (classification.policyPacks || {})[packId];
  if (!pack) return;
  const groups = buildMatrixGroups();
  for (const [domain, group] of groups.entries()) {
    const sameSite = isSameSite(domain, sourceDomain);
    const tracker = isKnownTrackerDomain(domain);
    for (const [resourceType] of RESOURCE_COLUMNS) {
      if (resourceType === TYPE_WILDCARD) continue;
      const seenOrCookie = resourceType === "cookie" ? Object.keys(group.aggregate).length > 0 : Boolean(group.aggregate[resourceType]);
      if (!seenOrCookie) continue;
      if (!sameSite && (pack.blockThirdParty || []).includes(resourceType)) setWorkingCellPolicy(domain, resourceType, "block");
      if (tracker && (pack.blockKnownTrackers || []).includes(resourceType)) setWorkingCellPolicy(domain, resourceType, "block");
    }
  }
  await applyDraft();
  render();
}

async function toggleTrustSite() {
  const trusted = (state.trustedSites || []).includes(sourceDomain);
  await send({ type: "SET_TRUSTED_SITE", payload: { sourceDomain, trusted: !trusted } });
  state = await send({ type: "GET_STATE" });
  render();
}

async function openSidePanel() {
  if (!chrome.sidePanel?.open) {
    renderError("Side panel API not available in this browser.");
    return;
  }
  await chrome.sidePanel.open({ windowId: currentTab.windowId });
  window.close();
}

/* ------------------------------------------------------------------ *
 * Matched-rules viewer
 * ------------------------------------------------------------------ */

async function toggleMatchedRules() {
  matchesOpen = !matchesOpen;
  $("matches").hidden = !matchesOpen;
  $("showMatches").textContent = matchesOpen ? "Hide matched rules" : "Show matched rules";
  if (matchesOpen) await renderMatchedRules();
}

async function renderMatchedRules() {
  try {
    const result = await send({ type: "GET_MATCHED_RULES", payload: { tabId: currentTab.id } });
    const matches = result.matches || [];
    const warning = result.warning ? `<p class="warn">${escapeHtml(result.warning)}</p>` : "";
    if (matches.length === 0) {
      $("matches").innerHTML = `<h2>Matched VIGIL rules</h2>${warning}<p class="muted">No VIGIL DNR matches reported for this tab yet. Reload the page after changing rules. Note: the browser rate-limits this viewer to roughly 20 refreshes per 10 minutes.</p>`;
      return;
    }
    $("matches").innerHTML = `<h2>Matched VIGIL rules</h2>${warning}${matches.slice(0, 30).map(renderMatch).join("")}`;
  } catch (error) {
    $("matches").innerHTML = `<h2>Matched VIGIL rules</h2><p class="error">${escapeHtml(String(error?.message || error))}</p>`;
  }
}

function renderMatch(match) {
  const when = match.timeStamp ? new Date(match.timeStamp).toLocaleTimeString() : "unknown time";
  const source = (match.sourceDomains || []).join(", ");
  const scope = match.scope === "global" ? "global" : `scope ${escapeHtml(source)}`;
  const target = escapeHtml((match.requestDomains || []).join(", ") || "*");
  const types = escapeHtml((match.resourceTypes || []).join(", "));
  const headers = match.headers || [];
  const actionClass = match.action === "block" ? "trackerDomain" : "sameSite";

  let reason;
  if (match.action === "block") {
    reason = `Blocked ${target} (${types}) by ${match.store} ${scope} policy.`;
  } else if (match.action === "modifyHeaders") {
    if (headers.includes("cookie") || headers.includes("set-cookie")) reason = `Stripped cookies for ${target} by ${match.store} ${scope} cookie policy.`;
    else if (headers.includes("referer")) reason = `Stripped the Referer header (${scope} strip-referrer switch).`;
    else if (headers.includes("content-security-policy")) reason = `Injected a CSP header (${scope} no-inline-script / no-worker switch).`;
    else reason = `Modified headers for ${target}.`;
  } else if (match.action === "upgradeScheme") {
    reason = `Upgraded an http:// request to https:// (${scope} https-upgrade switch).`;
  } else if (match.action === "redirect") {
    reason = `Stripped tracking params from ${target} (${scope} strip-tracking-params switch).`;
  } else if (match.action === "allowAllRequests") {
    reason = match.priority >= PRIORITY.TRUST_SITE
      ? `Trusted frame tree for ${target} (temporary trust).`
      : `Matrix off for ${target} (persistent kill switch).`;
  } else {
    reason = `Allowed ${target} (${types}) because a higher-priority ${match.store} ${scope} allow-rule overrode a lower block.`;
  }

  return `
    <div class="match">
      <div><strong class="${actionClass}">${escapeHtml(match.action)}</strong> <span class="muted">${escapeHtml(match.store)} · ${scope} · priority ${escapeHtml(match.priority)}</span></div>
      <div><code>${target}</code> <span class="muted">${types}</span></div>
      <div>${reason}</div>
      <div class="muted">rule ${escapeHtml(match.ruleId)} · ${escapeHtml(when)}</div>
    </div>
  `;
}

async function exportPolicy() {
  const result = await send({ type: "EXPORT_STATE" });
  const blob = new Blob([JSON.stringify(result.export, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `vigil-matrix-lite-policy-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ *
 * Utilities
 * ------------------------------------------------------------------ */

function setBusy(message) {
  $("site").textContent = message;
  $("matrix").innerHTML = "";
  $("switches").innerHTML = "";
  $("matches").hidden = true;
}

function renderError(message) {
  $("site").textContent = "Not available";
  $("summary").innerHTML = "";
  $("modeStatus").textContent = "";
  $("switches").innerHTML = "";
  $("sidePanelHint").hidden = true;
  $("matrix").innerHTML = `<div class="error">${escapeHtml(message)}</div>`;
}

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

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function deepEqual(a, b) {
  return JSON.stringify(sortObject(a || {})) === JSON.stringify(sortObject(b || {}));
}

function sortObject(input) {
  if (Array.isArray(input)) return input.map(sortObject);
  if (!input || typeof input !== "object") return input;
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortObject(v)]));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
