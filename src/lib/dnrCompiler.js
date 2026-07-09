/*
 * VIGIL Matrix Lite - policy -> declarativeNetRequest compiler (v0.10)
 *
 * Pure module: no chrome.* usage. The service worker feeds it policy objects
 * and applies the returned rule arrays; the node test suite exercises it
 * directly against a miniature DNR evaluator.
 *
 * v0.10 model
 * -----------
 * A matrix cell is addressed by a COORDINATE with four dimensions:
 *
 *   scope level   s: 0 = global ("*")
 *                    1 = site scope equal to its registrable domain
 *                    2..(MAX_NESTING_DEPTH+1) = site scope N labels below the
 *                        registrable domain (real depth, capped)
 *   target spec   t: 0 = "*" (all hosts)
 *                    1 = registrable domain
 *                    2..(MAX_NESTING_DEPTH+1) = target N labels below the
 *                        registrable domain (real depth, capped)
 *   type spec     y: 0 = "*" (all matrix types), 1 = a specific type
 *   layer          : 0 = committed (dynamic store), 1 = draft (session store)
 *
 * The coordinate is encoded into the DNR rule priority so that Chrome's own
 * "highest priority wins" evaluation reproduces uMatrix's "most specific cell
 * wins" semantics, including drafts shadowing the committed layer:
 *
 *   matrix priority = 10  + s*32 + t*4 + y*2 + layer   (range 10..265)
 *   cookie priority  = 300 + s*16 + t*2 + layer         (range 300..427)
 *
 * s and t encode REAL label depth below the registrable domain (not a fixed
 * 3-level cap): nested hostname scopes/targets resolve by specificity via
 * the priority number, the same way any other coordinate does. Depth is
 * capped at MAX_NESTING_DEPTH (6) purely to bound the ladder's size - no
 * legitimate hostname nests that deep. Two authored coordinates that both
 * exceed the cap AND are in an ancestor/descendant relationship AND disagree
 * on action are the one residual case the priority number cannot resolve;
 * see findSpecificityConflicts(), which refuses to compile them silently
 * rather than let Chrome's equal-priority tiebreak (allow wins) decide.
 *
 * Because the smallest step between two DIFFERENT coordinates is 2 and the
 * draft layer only adds 1, a draft rule always shadows its own committed cell
 * but never outranks any more specific cell.
 *
 * Cookie rules (modifyHeaders) sit above every allow priority on purpose:
 * Chrome suppresses a modifyHeaders rule whenever an allow rule of equal or
 * higher priority matches, so cookie stripping must outrank all allows.
 * (Cookie cells only ever compile as "block" - see cellFor - so a cookie/
 * cookie priority tie is harmless; the depth encoding is reused there only
 * to keep one coordinate system instead of two.)
 *
 * Per-scope switches (uMatrix's blue puzzle toggles) compile to dedicated
 * rules above the matrix bands and are committed immediately (no draft
 * layer): strip-referrer, https-upgrade, no-inline-script (CSP),
 * no-worker (CSP) and matrix-off (persistent allowAllRequests). Switches are
 * independent per-scope toggles, not competing cells, so they deliberately
 * keep the cheap global/apex/deeper 3-tier scope bump (switchScopeTier)
 * rather than the widened depth-aware scopeLevel - see switchRules.
 */

import { registrableDomain } from "./domains.js";

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

export const GLOBAL_SCOPE = "*";
export const TARGET_WILDCARD = "*";
export const TYPE_WILDCARD = "*";

export const MATRIX_TYPES = [
  "script",
  "xmlhttprequest",
  "sub_frame",
  "image",
  "stylesheet",
  "font",
  "media",
  "cookie"
];

// Matrix column -> DNR resourceTypes it governs.
export const MATRIX_TO_DNR = {
  script: ["script"],
  xmlhttprequest: ["xmlhttprequest", "websocket", "ping", "other"],
  sub_frame: ["sub_frame"],
  image: ["image"],
  stylesheet: ["stylesheet"],
  font: ["font"],
  media: ["media", "object"]
  // "cookie" is special-cased: modifyHeaders over COOKIE_DNR_TYPES_*.
  // TYPE_WILDCARD is special-cased: ALL_SUBRESOURCE_TYPES.
};

// Every DNR type the matrix governs, main_frame deliberately excluded so a
// type-"*" block (or default-deny) never breaks top-level navigation.
export const ALL_SUBRESOURCE_TYPES = [
  "script", "xmlhttprequest", "sub_frame", "image", "stylesheet",
  "font", "media", "websocket", "ping", "object", "other"
];
export const DEFAULT_DENY_TYPES = ALL_SUBRESOURCE_TYPES;

export const COOKIE_DNR_TYPES_GLOBAL = ["main_frame", ...ALL_SUBRESOURCE_TYPES];
// Site-scoped cookie rules skip main_frame: top navigations carry the
// *previous* page as initiator, which is not what a site policy means, and
// stripping first-party cookies via a site rule would log users out of the
// scoped site itself.
export const COOKIE_DNR_TYPES_SITE = ALL_SUBRESOURCE_TYPES;

export const DYNAMIC_RULE_BASE_ID = 100000;
export const DYNAMIC_RULE_MAX_ID = 199999;
export const SESSION_RULE_BASE_ID = 200000;
export const SESSION_RULE_MAX_ID = 299999;

export const SWITCH_NAMES = [
  "matrix-off",        // persistent allowAllRequests for the scope
  "no-inline-script",  // CSP: block inline <script> execution
  "no-worker",         // CSP: block Worker / SharedWorker / ServiceWorker
  "strip-referrer",    // remove the Referer request header
  "https-upgrade"      // upgrade http:// requests to https://
];

// Real label depth below the registrable domain that scope/target
// specificity distinguishes before falling back to a shared "deepest" band.
// No legitimate hostname nests this deep; see findSpecificityConflicts for
// the (vanishingly rare) residual collision this cap can still produce.
export const MAX_NESTING_DEPTH = 6;

// scopeLevel/targetSpecificity each return 0..DEPTH_CODE_MAX (8 values: 0 for
// "*"/global, 1 for the registrable domain itself, 2..7 for depth 1..6).
const DEPTH_CODE_MAX = MAX_NESTING_DEPTH + 1;
const DEPTH_CODE_RANGE = DEPTH_CODE_MAX + 1; // 8

export const PRIORITY = {
  DEFAULT_DENY: 1,
  STATIC_BLOCKLIST: 5,     // used by tools/build-blocklist.mjs; any explicit
                           // allow cell (>= MATRIX_BASE) overrides the list
  MATRIX_BASE: 10,         // + s*32 + t*4 + y*2 + layer   -> 10..265
  COOKIE_BASE: 300,        // + s*16 + t*2 + layer         -> 300..427
  STRIP_REFERRER: 450,     // + switchScopeTier (0..2)     -> 450..452
  HTTPS_UPGRADE: 460,      // + switchScopeTier
  CSP_NO_INLINE: 470,      // + switchScopeTier
  CSP_NO_WORKER: 476,      // + switchScopeTier
  MATRIX_OFF: 500,         // committed allowAllRequests (kill switch)
  TRUST_SITE: 510          // session allowAllRequests (temporary trust)
};

// CSP value that blocks inline scripts while leaving external scripts to the
// matrix: every external source stays syntactically allowed, but the absence
// of 'unsafe-inline' disables inline <script> blocks and inline handlers.
export const CSP_NO_INLINE_VALUE = "script-src 'unsafe-eval' * blob: data:";
export const CSP_NO_WORKER_VALUE = "worker-src 'none'";

/* ------------------------------------------------------------------ *
 * Coordinate math
 * ------------------------------------------------------------------ */

function labelCount(host) {
  return String(host || "").split(".").filter(Boolean).length;
}

/*
 * 0 = global, 1 = registrable-domain scope, 2..DEPTH_CODE_MAX = real label
 * depth below the registrable domain (1..MAX_NESTING_DEPTH), capped at
 * DEPTH_CODE_MAX for anything deeper.
 */
export function scopeLevel(scope, suffixes) {
  if (scope === GLOBAL_SCOPE) return 0;
  const reg = registrableDomain(scope, suffixes);
  if (scope === reg) return 1;
  const depth = labelCount(scope) - labelCount(reg);
  return 1 + Math.min(Math.max(depth, 1), MAX_NESTING_DEPTH);
}

/*
 * 0 = "*", 1 = registrable domain, 2..DEPTH_CODE_MAX = real label depth
 * below the registrable domain (1..MAX_NESTING_DEPTH), capped.
 */
export function targetSpecificity(target, suffixes) {
  if (target === TARGET_WILDCARD) return 0;
  const reg = registrableDomain(target, suffixes);
  if (target === reg) return 1;
  const depth = labelCount(target) - labelCount(reg);
  return 1 + Math.min(Math.max(depth, 1), MAX_NESTING_DEPTH);
}

/*
 * Switches are independent per-scope toggles (they modifyHeaders-append or
 * gate their own condition, never compete against another scope's switch
 * rule for the same coordinate), so they don't need - and must NOT use -
 * the widened depth-aware scopeLevel above: reusing it would make a deeply
 * nested switch scope's "+ s" bump collide with the next switch band's base.
 * 0 = global, 1 = registrable-domain scope, 2 = any deeper hostname scope.
 */
export function switchScopeTier(scope, suffixes) {
  if (scope === GLOBAL_SCOPE) return 0;
  return scope === registrableDomain(scope, suffixes) ? 1 : 2;
}

export function matrixPriority({ s, t, y, layer }) {
  return PRIORITY.MATRIX_BASE + s * (DEPTH_CODE_RANGE * 4) + t * 4 + y * 2 + layer;
}

export function cookiePriority({ s, t, layer }) {
  return PRIORITY.COOKIE_BASE + s * (DEPTH_CODE_RANGE * 2) + t * 2 + layer;
}

function cellPriority({ scope, target, matrixType, layer, suffixes }) {
  const s = scopeLevel(scope, suffixes);
  const t = targetSpecificity(target, suffixes);
  if (matrixType === "cookie") return cookiePriority({ s, t, layer });
  const y = matrixType === TYPE_WILDCARD ? 0 : 1;
  return matrixPriority({ s, t, y, layer });
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

export function validateDomain(domain, fieldName) {
  if (!domain || typeof domain !== "string") throw new Error(`${fieldName} is required`);
  // DNR domain fields require ASCII; IDNs must be punycoded before storage.
  if (!/^[a-z0-9.-]+$/i.test(domain)) throw new Error(`${fieldName} must be ASCII domain text: ${domain}`);
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) {
    throw new Error(`${fieldName} has invalid dot placement: ${domain}`);
  }
}

export function validateScope(scope, fieldName = "scope") {
  if (scope === GLOBAL_SCOPE) return;
  validateDomain(scope, fieldName);
}

export function validateTarget(target, fieldName = "target") {
  if (target === TARGET_WILDCARD) return;
  validateDomain(target, fieldName);
}

export function validateMatrixType(matrixType) {
  if (matrixType === TYPE_WILDCARD) return;
  if (!MATRIX_TYPES.includes(matrixType)) throw new Error(`Unsupported resource type: ${matrixType}`);
}

export function validateAction(matrixType, action, allowNoop = false) {
  const allowed = matrixType === "cookie"
    ? (allowNoop ? ["noop", "block"] : ["block"])
    : (allowNoop ? ["noop", "allow", "block"] : ["allow", "block"]);
  if (!allowed.includes(action)) {
    throw new Error(`Unsupported action "${action}" for type "${matrixType}"`);
  }
}

export function validateTargetPolicy(targetPolicy) {
  for (const [target, typePolicies] of Object.entries(targetPolicy || {})) {
    validateTarget(target, "target");
    for (const [matrixType, action] of Object.entries(typePolicies || {})) {
      validateMatrixType(matrixType);
      validateAction(matrixType, action, false);
    }
  }
}

export function validateSitePolicies(sitePolicies) {
  for (const [scope, sitePolicy] of Object.entries(sitePolicies || {})) {
    validateDomain(scope, "scope");
    validateTargetPolicy(sitePolicy || {});
  }
}

export function validateSwitches(switches) {
  for (const [scope, flags] of Object.entries(switches || {})) {
    validateScope(scope, "switch scope");
    for (const [name, on] of Object.entries(flags || {})) {
      if (!SWITCH_NAMES.includes(name)) throw new Error(`Unknown switch: ${name}`);
      if (typeof on !== "boolean") throw new Error(`Switch ${name} must be boolean`);
    }
  }
}

export function isEmptyTargetPolicy(targetPolicy) {
  return Object.keys(targetPolicy || {}).length === 0;
}

/* ------------------------------------------------------------------ *
 * Outcome resolution (shared by session neutralizers and the popup UI)
 *
 * Given a request context (scope chain of the page host), a target host and
 * a matrix type, walk every LESS SPECIFIC coordinate that would also match
 * the request and return the strongest applicable action. This is the exact
 * mirror of what the compiled priority ladder does at request time, which is
 * why the popup can use it to preview "inherited" cell states truthfully.
 * ------------------------------------------------------------------ */

/* All scopes that apply while browsing `host`, most specific first. */
export function scopeChainFor(host, suffixes) {
  if (host === GLOBAL_SCOPE) return [GLOBAL_SCOPE];
  const chain = [];
  const reg = registrableDomain(host, suffixes);
  let cursor = host;
  while (cursor && cursor !== reg && labelCount(cursor) > labelCount(reg)) {
    chain.push(cursor);
    cursor = cursor.split(".").slice(1).join(".");
  }
  chain.push(reg);
  chain.push(GLOBAL_SCOPE);
  return chain;
}

/* All target keys that cover `target`, most specific first. */
export function targetChainFor(target, suffixes) {
  if (target === TARGET_WILDCARD) return [TARGET_WILDCARD];
  const chain = scopeChainFor(target, suffixes);
  chain[chain.length - 1] = TARGET_WILDCARD; // replace "*" scope with "*" target
  return chain;
}

/*
 * policies: { [scope]: targetPolicy } merged view ("*" key = global scope).
 * maxPriorityExclusive: only consider coordinates strictly below this
 * priority (pass Infinity for a full effective-outcome lookup).
 * Returns { action, coord } for the winning cell, or
 * { action: null } when only the default applies.
 */
export function resolveOutcome({ contextHost, target, matrixType, policies, suffixes, maxPriorityExclusive = Infinity }) {
  if (matrixType === "cookie") return { action: null, coord: null }; // header rules are not chained
  let best = null;
  for (const scope of scopeChainFor(contextHost, suffixes)) {
    const targetPolicy = policies?.[scope];
    if (!targetPolicy) continue;
    for (const tg of targetChainFor(target, suffixes)) {
      for (const ty of [matrixType, TYPE_WILDCARD]) {
        const action = targetPolicy?.[tg]?.[ty];
        if (action !== "block" && action !== "allow") continue;
        const priority = cellPriority({ scope, target: tg, matrixType: ty, layer: 0, suffixes });
        if (priority >= maxPriorityExclusive) continue;
        if (!best || priority > best.priority) {
          best = { action, priority, coord: { scope, target: tg, matrixType: ty } };
        }
      }
    }
  }
  return best ? { action: best.action, coord: best.coord } : { action: null, coord: null };
}

/* ------------------------------------------------------------------ *
 * Cell collection
 *
 * A "cell" is one matrix decision:
 *   { scope, target, matrixType, kind, priority }
 * kind: "block" | "allow" | "cookie". scope "*" means global.
 * ------------------------------------------------------------------ */

function cellFor({ scope, target, matrixType, action, layer, suffixes }) {
  if (matrixType === "cookie") {
    if (action !== "block") return null; // cookie cells only compile as block
    return { scope, target, matrixType, kind: "cookie", priority: cellPriority({ scope, target, matrixType, layer, suffixes }) };
  }
  if (action !== "block" && action !== "allow") return null;
  return { scope, target, matrixType, kind: action, priority: cellPriority({ scope, target, matrixType, layer, suffixes }) };
}

export function collectCommittedCells({ sitePolicies, globalPolicy, suffixes }) {
  const cells = [];
  const scopes = { [GLOBAL_SCOPE]: globalPolicy || {}, ...(sitePolicies || {}) };
  for (const [scope, targetPolicy] of Object.entries(scopes)) {
    validateScope(scope, "scope");
    for (const [target, typePolicies] of Object.entries(targetPolicy || {})) {
      validateTarget(target, "target");
      for (const [matrixType, action] of Object.entries(typePolicies || {})) {
        validateMatrixType(matrixType);
        const cell = cellFor({ scope, target, matrixType, action, layer: 0, suffixes });
        if (cell) cells.push(cell);
      }
    }
  }
  return cells;
}

/*
 * Detects the one case the priority ladder cannot resolve by specificity:
 * two committed cells whose scope AND target both hit the depth cap (so they
 * emit the identical priority) AND are in a real ancestor/descendant
 * relationship (so a single request's initiator/target chain can match both)
 * AND disagree on action. Anything else - different depths within the cap,
 * or same-priority cells that never actually compete (unrelated sibling
 * hostnames, disjoint types) - is not a conflict and must not be flagged.
 *
 * Returns a list of { a, b } pairs (each a {scope,target,matrixType,action}
 * coordinate) for the caller to reject before persisting/compiling. Cookie
 * cells are excluded: they only ever compile as "block", so a tie there is
 * never ambiguous.
 */
export function findSpecificityConflicts({ sitePolicies, globalPolicy, suffixes }) {
  const cells = collectCommittedCells({ sitePolicies: sitePolicies || {}, globalPolicy: globalPolicy || {}, suffixes });

  const byPriority = new Map();
  for (const cell of cells) {
    if (cell.kind === "cookie") continue;
    if (!byPriority.has(cell.priority)) byPriority.set(cell.priority, []);
    byPriority.get(cell.priority).push(cell);
  }

  const isSameOrAncestor = (x, y) => x === y || y.endsWith(`.${x}`) || x.endsWith(`.${y}`);
  const typesOverlap = (a, b) => a === b || a === TYPE_WILDCARD || b === TYPE_WILDCARD;

  const conflicts = [];
  for (const group of byPriority.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (a.kind === b.kind) continue; // same action: no ambiguity to resolve
        if (!typesOverlap(a.matrixType, b.matrixType)) continue;
        if (!isSameOrAncestor(a.scope, b.scope)) continue;
        if (!isSameOrAncestor(a.target, b.target)) continue;
        conflicts.push({
          a: { scope: a.scope, target: a.target, matrixType: a.matrixType, action: a.kind },
          b: { scope: b.scope, target: b.target, matrixType: b.matrixType, action: b.kind }
        });
      }
    }
  }
  return conflicts;
}

export function collectTargetPairs(...targetPolicies) {
  const seen = new Set();
  const pairs = [];
  for (const targetPolicy of targetPolicies || []) {
    for (const [target, typePolicies] of Object.entries(targetPolicy || {})) {
      validateTarget(target, "target");
      for (const matrixType of Object.keys(typePolicies || {})) {
        validateMatrixType(matrixType);
        const key = `${target}|${matrixType}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ target, matrixType });
      }
    }
  }
  return pairs.sort((a, b) => a.target.localeCompare(b.target) || a.matrixType.localeCompare(b.matrixType));
}

/*
 * Draft (session) overlay cells.
 *
 * For every scope being edited, each (target, type) pair present in either
 * the committed or the draft policy produces:
 * - the draft action itself at layer 1 (shadowing the committed cell), or
 * - if the draft removed a committed cell (draft noop over committed value):
 *   a NEUTRALIZER at layer 1 whose action equals whatever the priority
 *   ladder would resolve to *without* that cell - a less specific merged
 *   cell if one exists, otherwise the default (block under default-deny,
 *   allow otherwise). Emitting the neutralizer at the removed cell's own
 *   coordinate keeps every more specific rule winning as before.
 *
 * Cookie cells cannot be neutralized: neutralization would need an allow
 * rule above the cookie band, which would suppress unrelated header rules.
 * So draft cookie *blocks* apply immediately, while *removing* a committed
 * cookie block only takes effect after Save. This is surfaced in the UI.
 */
export function collectDraftCells({ committedSitePolicies, committedGlobalPolicy, draftSitePolicies, draftGlobalPolicy, defaultDeny, suffixes }) {
  const cells = [];

  // Merged view: what the world looks like with all drafts applied. Used by
  // the neutralizer resolution so removed cells fall back onto the *draft*
  // state of less specific layers, not their committed state.
  const mergedView = { [GLOBAL_SCOPE]: draftGlobalPolicy ?? (committedGlobalPolicy || {}) };
  for (const [scope, policy] of Object.entries(committedSitePolicies || {})) mergedView[scope] = policy || {};
  for (const [scope, policy] of Object.entries(draftSitePolicies || {})) mergedView[scope] = policy || {};

  const editedScopes = [];
  if (draftGlobalPolicy !== null && draftGlobalPolicy !== undefined) editedScopes.push(GLOBAL_SCOPE);
  editedScopes.push(...Object.keys(draftSitePolicies || {}));

  for (const scope of editedScopes) {
    validateScope(scope, "scope");
    const committedPolicy = scope === GLOBAL_SCOPE
      ? (committedGlobalPolicy || {})
      : (committedSitePolicies?.[scope] || {});
    const draftPolicy = scope === GLOBAL_SCOPE
      ? (draftGlobalPolicy || {})
      : (draftSitePolicies?.[scope] || {});

    for (const { target, matrixType } of collectTargetPairs(committedPolicy, draftPolicy)) {
      const draftAction = draftPolicy?.[target]?.[matrixType] || "noop";
      const committedAction = committedPolicy?.[target]?.[matrixType] || "noop";

      if (matrixType === "cookie") {
        if (draftAction === "block" && committedAction !== "block") {
          cells.push(cellFor({ scope, target, matrixType, action: "block", layer: 1, suffixes }));
        }
        continue;
      }

      let action = null;
      if (draftAction === "block" || draftAction === "allow") {
        if (draftAction === committedAction) continue; // no-op: dynamic rule already does this
        action = draftAction;
      } else if (committedAction !== "noop") {
        // Neutralizer: resolve what applies below the removed cell.
        const below = resolveOutcome({
          contextHost: scope,
          target,
          matrixType,
          policies: mergedView,
          suffixes,
          maxPriorityExclusive: cellPriority({ scope, target, matrixType, layer: 0, suffixes })
        });
        action = below.action || (defaultDeny ? "block" : "allow");
      }
      if (!action) continue;
      cells.push(cellFor({ scope, target, matrixType, action, layer: 1, suffixes }));
    }
  }

  return cells.filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Compaction: cells -> merged rule specs -> DNR rules
 * ------------------------------------------------------------------ */

function dnrTypesForCell(cell) {
  if (cell.kind === "cookie") {
    return cell.scope === GLOBAL_SCOPE ? COOKIE_DNR_TYPES_GLOBAL : COOKIE_DNR_TYPES_SITE;
  }
  if (cell.matrixType === TYPE_WILDCARD) return ALL_SUBRESOURCE_TYPES;
  return MATRIX_TO_DNR[cell.matrixType] || [];
}

/*
 * Two-pass merge:
 * 1) same (scope, kind, priority, target) -> union of resourceTypes
 * 2) same (scope, kind, priority, typesKey) -> merged requestDomains
 * Priority encodes the coordinate, so cells of different specificity can
 * never merge (they carry different priorities by construction).
 */
export function compactCells(cells) {
  const byTarget = new Map();
  for (const cell of cells || []) {
    const key = [cell.scope, cell.kind, cell.priority, cell.target].join("\u0000");
    if (!byTarget.has(key)) {
      byTarget.set(key, {
        scope: cell.scope,
        kind: cell.kind,
        priority: cell.priority,
        target: cell.target,
        dnrTypes: new Set()
      });
    }
    const entry = byTarget.get(key);
    for (const t of dnrTypesForCell(cell)) entry.dnrTypes.add(t);
  }

  const byTypes = new Map();
  for (const entry of byTarget.values()) {
    const typesKey = Array.from(entry.dnrTypes).sort().join(",");
    const key = [entry.scope, entry.kind, entry.priority, typesKey].join("\u0000");
    if (!byTypes.has(key)) {
      byTypes.set(key, {
        scope: entry.scope,
        kind: entry.kind,
        priority: entry.priority,
        dnrTypes: Array.from(entry.dnrTypes).sort(),
        targets: []
      });
    }
    byTypes.get(key).targets.push(entry.target);
  }

  const specs = Array.from(byTypes.values());
  for (const spec of specs) spec.targets.sort();
  specs.sort((a, b) =>
    a.priority - b.priority ||
    a.scope.localeCompare(b.scope) ||
    a.kind.localeCompare(b.kind) ||
    a.targets[0].localeCompare(b.targets[0])
  );
  return specs;
}

export function specToRule(spec, id) {
  const condition = { resourceTypes: spec.dnrTypes };
  // Target "*" means "all hosts": omit requestDomains entirely.
  const concreteTargets = spec.targets.filter((t) => t !== TARGET_WILDCARD);
  if (concreteTargets.length !== spec.targets.length && concreteTargets.length > 0) {
    // Cannot express "these domains OR everything" in one rule; compaction
    // never produces this because "*" has its own priority band.
    throw new Error("Wildcard target merged with concrete targets");
  }
  if (concreteTargets.length > 0) condition.requestDomains = concreteTargets;
  if (spec.scope !== GLOBAL_SCOPE) condition.initiatorDomains = [spec.scope];

  let action;
  if (spec.kind === "cookie") {
    action = {
      type: "modifyHeaders",
      requestHeaders: [{ header: "cookie", operation: "remove" }],
      responseHeaders: [{ header: "set-cookie", operation: "remove" }]
    };
  } else {
    action = { type: spec.kind };
  }

  return { id, priority: spec.priority, action, condition };
}

export function specsToRules(specs, baseId, maxId, label = "DNR") {
  const rules = [];
  let id = baseId;
  for (const spec of specs || []) {
    if (id > maxId) throw new Error(`${label} rule ID range exhausted`);
    rules.push(specToRule(spec, id++));
  }
  return rules;
}

/* ------------------------------------------------------------------ *
 * Special rules
 * ------------------------------------------------------------------ */

export function defaultDenyRule(id) {
  return {
    id,
    priority: PRIORITY.DEFAULT_DENY,
    action: { type: "block" },
    condition: {
      urlFilter: "*",
      resourceTypes: DEFAULT_DENY_TYPES
    }
  };
}

/*
 * Per-scope switch rules. Committed-only (no draft layer): switches are
 * toggles, not experiments, and apply the moment they are flipped.
 */
export function switchRules(switches, suffixes, allocateId) {
  validateSwitches(switches || {});
  const rules = [];

  for (const [scope, flags] of Object.entries(switches || {})) {
    const s = switchScopeTier(scope, suffixes);
    const isGlobal = scope === GLOBAL_SCOPE;
    const forSite = (condition) => (isGlobal ? condition : { ...condition, initiatorDomains: [scope] });

    if (flags["strip-referrer"]) {
      // Site scopes exclude main_frame: a navigation's initiator is the
      // previous page, which is not what "this site's policy" means.
      rules.push({
        id: allocateId(),
        priority: PRIORITY.STRIP_REFERRER + s,
        action: { type: "modifyHeaders", requestHeaders: [{ header: "referer", operation: "remove" }] },
        condition: forSite({ resourceTypes: isGlobal ? COOKIE_DNR_TYPES_GLOBAL : ALL_SUBRESOURCE_TYPES })
      });
    }

    if (flags["https-upgrade"]) {
      if (isGlobal) {
        rules.push({
          id: allocateId(),
          priority: PRIORITY.HTTPS_UPGRADE + s,
          action: { type: "upgradeScheme" },
          condition: { urlFilter: "|http://", resourceTypes: COOKIE_DNR_TYPES_GLOBAL }
        });
      } else {
        // Two rules: the site's own navigations (requestDomains) plus every
        // subresource the site initiates (initiatorDomains).
        rules.push({
          id: allocateId(),
          priority: PRIORITY.HTTPS_UPGRADE + s,
          action: { type: "upgradeScheme" },
          condition: { urlFilter: "|http://", requestDomains: [scope], resourceTypes: ["main_frame"] }
        });
        rules.push({
          id: allocateId(),
          priority: PRIORITY.HTTPS_UPGRADE + s,
          action: { type: "upgradeScheme" },
          condition: { urlFilter: "|http://", initiatorDomains: [scope], resourceTypes: ALL_SUBRESOURCE_TYPES }
        });
      }
    }

    for (const [name, priorityBase, cspValue] of [
      ["no-inline-script", PRIORITY.CSP_NO_INLINE, CSP_NO_INLINE_VALUE],
      ["no-worker", PRIORITY.CSP_NO_WORKER, CSP_NO_WORKER_VALUE]
    ]) {
      if (!flags[name]) continue;
      const action = {
        type: "modifyHeaders",
        responseHeaders: [{ header: "Content-Security-Policy", operation: "append", value: cspValue }]
      };
      if (isGlobal) {
        rules.push({
          id: allocateId(),
          priority: priorityBase + s,
          action,
          condition: { resourceTypes: ["main_frame", "sub_frame"] }
        });
      } else {
        // The page itself (requestDomains) plus frames it embeds
        // (initiatorDomains). CSP response headers apply to the document
        // they arrive on, hence the split.
        rules.push({
          id: allocateId(),
          priority: priorityBase + s,
          action,
          condition: { requestDomains: [scope], resourceTypes: ["main_frame", "sub_frame"] }
        });
        rules.push({
          id: allocateId(),
          priority: priorityBase + s,
          action,
          condition: { initiatorDomains: [scope], resourceTypes: ["sub_frame"] }
        });
      }
    }

    if (flags["matrix-off"]) {
      // Persistent kill switch: the whole frame tree of the scope bypasses
      // every VIGIL rule, including cookie stripping and CSP switches.
      const condition = { resourceTypes: ["main_frame"] };
      if (!isGlobal) condition.requestDomains = [scope];
      rules.push({
        id: allocateId(),
        priority: PRIORITY.MATRIX_OFF,
        action: { type: "allowAllRequests" },
        condition
      });
    }
  }

  return rules;
}

/*
 * Temporary "trust this site": allowAllRequests on the main frame lets the
 * whole frame hierarchy of that site bypass every VIGIL rule (blocks,
 * cookie stripping, CSP) until the trust is lifted or the browser restarts.
 */
export function trustSiteRules(trustedSites, allocateId) {
  const rules = [];
  for (const site of trustedSites || []) {
    validateDomain(site, "trustedSite");
    rules.push({
      id: allocateId(),
      priority: PRIORITY.TRUST_SITE,
      action: { type: "allowAllRequests" },
      condition: {
        requestDomains: [site],
        resourceTypes: ["main_frame"]
      }
    });
  }
  return rules;
}

function idAllocator(baseId, maxId, label) {
  let id = baseId;
  return () => {
    if (id > maxId) throw new Error(`${label} rule ID range exhausted`);
    return id++;
  };
}

/* ------------------------------------------------------------------ *
 * Top-level compile entry points
 * ------------------------------------------------------------------ */

export function compileCommittedRules({ sitePolicies, globalPolicy, switches, defaultDeny = false, suffixes }) {
  validateSitePolicies(sitePolicies || {});
  validateTargetPolicy(globalPolicy || {});
  validateSwitches(switches || {});

  const cells = collectCommittedCells({ sitePolicies: sitePolicies || {}, globalPolicy: globalPolicy || {}, suffixes });
  const specs = compactCells(cells);

  const allocate = idAllocator(DYNAMIC_RULE_BASE_ID, DYNAMIC_RULE_MAX_ID, "Dynamic");
  const rules = [];
  if (defaultDeny) rules.push(defaultDenyRule(allocate()));
  for (const spec of specs) rules.push(specToRule(spec, allocate()));
  rules.push(...switchRules(switches || {}, suffixes, allocate));
  return rules;
}

export function compileSessionRules({
  committedSitePolicies, committedGlobalPolicy,
  draftSitePolicies, draftGlobalPolicy,
  trustedSites, defaultDeny = false, suffixes
}) {
  validateSitePolicies(committedSitePolicies || {});
  validateTargetPolicy(committedGlobalPolicy || {});
  validateSitePolicies(draftSitePolicies || {});
  if (draftGlobalPolicy !== null && draftGlobalPolicy !== undefined) validateTargetPolicy(draftGlobalPolicy || {});

  const cells = collectDraftCells({
    committedSitePolicies: committedSitePolicies || {},
    committedGlobalPolicy: committedGlobalPolicy || {},
    draftSitePolicies: draftSitePolicies || {},
    draftGlobalPolicy: draftGlobalPolicy === undefined ? null : draftGlobalPolicy,
    defaultDeny,
    suffixes
  });
  const specs = compactCells(cells);

  const allocate = idAllocator(SESSION_RULE_BASE_ID, SESSION_RULE_MAX_ID, "Session");
  const rules = [];
  for (const spec of specs) rules.push(specToRule(spec, allocate()));
  rules.push(...trustSiteRules(trustedSites || [], allocate));
  return rules;
}
