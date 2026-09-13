import {
  GLOBAL_SCOPE, TYPE_WILDCARD, resolveOutcome, defaultOutcomeFor,
  normalizeDefaultMode, scopeChainFor, collectDraftCells, MATRIX_TO_DNR
} from "./dnrCompiler.js";

/* Provenance decorates the existing resolver; it does not choose a winner.
 * Inputs are the merged preview and committed policies, indexed by scope.
 * Static blocklists and actual browser request matches are not evaluated here.
 */
export function explainOutcome({
  contextHost, scope, target, matrixType, policies = {}, committedPolicies = {},
  defaultMode = "open", suffixes, switches = {}, trustedSites = []
}) {
  const mode = normalizeDefaultMode({ defaultMode });
  const context = { contextHost, target, matrixType, policies, suffixes, defaultMode: mode };
  // Reuse the compiler's session cells, including removal neutralizers. Resolve
  // their coordinates with the existing resolver, without another priority ladder.
  const { [GLOBAL_SCOPE]: committedGlobalPolicy = {}, ...committedSitePolicies } = committedPolicies;
  const draftSitePolicies = Object.fromEntries(
    [...new Set([...Object.keys(committedSitePolicies), ...Object.keys(policies)])]
      .filter((site) => site !== GLOBAL_SCOPE).map((site) => [site, policies[site] || {}])
  );
  const effectivePolicies = structuredClone(policies);
  for (const cell of collectDraftCells({
    committedGlobalPolicy, committedSitePolicies, draftSitePolicies,
    draftGlobalPolicy: policies[GLOBAL_SCOPE] || {}, defaultMode: mode, suffixes
  })) {
    if (cell.kind === "cookie") continue;
    effectivePolicies[cell.scope] ||= {};
    effectivePolicies[cell.scope][cell.target] ||= {};
    effectivePolicies[cell.scope][cell.target][cell.matrixType] = cell.kind;
  }
  const outcome = resolveOutcome({ ...context, policies: effectivePolicies });
  const coord = outcome.coord;
  const saved = committedPolicies[scope]?.[target]?.[matrixType];
  const working = policies[scope]?.[target]?.[matrixType];
  const removed = (saved === "block" || saved === "allow") && !working;
  const inherited = Boolean(coord && (coord.scope !== scope || coord.target !== target || coord.matrixType !== matrixType));
  const neutralized = Boolean(coord && !policies[coord.scope]?.[coord.target]?.[coord.matrixType]
    && committedPolicies[coord.scope]?.[coord.target]?.[coord.matrixType]);
  const draft = Boolean(!neutralized && coord && committedPolicies[coord.scope]?.[coord.target]?.[coord.matrixType] !== outcome.action);
  const chain = scopeChainFor(contextHost, suffixes);
  const bypass = trustedSites.some((site) => chain.includes(site)) ? "Temporary trust"
    : chain.some((site) => switches[site]?.["matrix-off"]) ? "Matrix off" : null;
  const result = {
    ...outcome, mode, inherited, draft, removed, bypass,
    source: neutralized ? "draft-removal" : draft ? "draft" : removed && (!coord || coord.scope !== scope || coord.target !== target || coord.matrixType !== matrixType)
      ? "draft-removal" : coord ? (inherited ? "inherited" : "explicit") : "default-mode"
  };

  if (matrixType === "cookie") {
    // Cookie blocks accumulate: a draft removal cannot undo a saved strip.
    // Reuse the resolver's hostname matching on just the cookie block cells;
    // All-type network cells never participate in header stripping.
    const cookiePolicies = {};
    for (const layer of [committedPolicies, policies]) {
      for (const [site, targets] of Object.entries(layer)) {
        for (const [host, types] of Object.entries(targets)) {
          if (types.cookie !== "block") continue;
          cookiePolicies[site] ||= {};
          cookiePolicies[site][host] = { script: "block" };
        }
      }
    }
    const cookie = resolveOutcome({ ...context, policies: cookiePolicies, matrixType: "script", defaultMode: null });
    const relaxedStrip = mode === "relaxed" && defaultOutcomeFor({ ...context, matrixType: "script" }) === "block";
    return {
      ...result, action: cookie.action || (relaxedStrip ? "block" : "allow"),
      coord: cookie.coord ? { ...cookie.coord, matrixType: "cookie" } : null,
      source: "cookie", pendingRemoval: removed,
      inherited: Boolean(cookie.coord && (cookie.coord.scope !== scope || cookie.coord.target !== target)),
      draft: Boolean(cookie.coord && committedPolicies[cookie.coord.scope]?.[cookie.coord.target]?.cookie !== "block")
    };
  }
  return result;
}

export function shouldRecommendBlock(context) {
  const outcome = explainOutcome(context);
  if (outcome.bypass || outcome.action !== "allow" || context.matrixType === TYPE_WILDCARD) return false;
  // Header stripping cannot tighten a request that network policy blocks.
  // Cookie cells cover every subresource column; retain a recommendation if
  // any governed column can load (including an explicit Hard-mode allow).
  if (context.matrixType === "cookie" && !Object.keys(MATRIX_TO_DNR).some((matrixType) =>
    explainOutcome({ ...context, matrixType }).action === "allow"
  )) return false;
  // Without an explicit allow, a separate enabled blocklist may already block
  // the request. Defer that recommendation rather than promise a tighter policy.
  if (context.blocklistEnabled && !outcome.coord && context.matrixType !== "cookie") return false;
  // A click in a broader scope cannot override a more specific allow.
  const candidate = {
    ...context.policies,
    [context.scope]: {
      ...context.policies?.[context.scope],
      [context.target]: { ...context.policies?.[context.scope]?.[context.target], [context.matrixType]: "block" }
    }
  };
  return explainOutcome({ ...context, policies: candidate }).action === "block";
}

export function explanationLines(outcome, { target, matrixType, blocklistEnabled = false }) {
  const type = { script: "scripts", xmlhttprequest: "XHR/fetch", sub_frame: "frames" }[matrixType] || matrixType;
  const mode = outcome.mode[0].toUpperCase() + outcome.mode.slice(1);
  const coord = outcome.coord;
  const origin = coord ? `${coord.scope === GLOBAL_SCOPE ? "Global (*)" : coord.scope} → ${coord.target} → ${coord.matrixType}` : null;
  const lines = [outcome.bypass ? `Matrix bypassed · ${outcome.bypass}`
    : `${outcome.action === "block" ? "Blocked" : "Allowed"} by ${matrixType === "cookie" ? "cookie" : "matrix"} policy`];
  if (outcome.source === "cookie") {
    lines.push(coord ? outcome.draft ? "Unsaved cookie block" : outcome.inherited ? "Inherited cookie stripping rule" : "Cookie stripping rule" : outcome.action === "block" ? "Relaxed mode · third-party cookies" : "No matching cookie stripping rule");
    if (outcome.pendingRemoval) lines.push("Unsaved removal · saved cookie block remains until Save");
  } else if (outcome.source === "draft") {
    lines.push("Unsaved change", "This draft supplies the winning rule");
  } else if (outcome.source === "draft-removal") {
    lines.push("Unsaved removal", "Session replacement rule remains effective until Save");
  } else if (coord) {
    lines.push(outcome.inherited ? "Inherited rule" : coord.scope === GLOBAL_SCOPE ? "Explicit global rule" : "Explicit rule for this site");
  } else {
    lines.push(outcome.mode === "relaxed" && outcome.action === "block"
      ? `Relaxed mode · third-party ${type}` : `${mode} mode`, "No explicit matching rule");
  }
  if (origin) lines.push(origin);
  if (matrixType !== "cookie" && coord && outcome.source !== "draft-removal" && outcome.action === "allow" && outcome.mode !== "open") {
    lines.push(`Explicit allow takes precedence over ${mode} mode`);
  }
  if (matrixType === TYPE_WILDCARD || target === "*") lines.push("Wildcard summary · individual hosts and types can differ");
  if (blocklistEnabled && matrixType !== "cookie") lines.push("Bundled blocklist is separate; not evaluated here");
  if (matrixType === "cookie") lines.push("Header policy only; application depends on browser site access");
  else lines.push("Matrix/default policy preview, not a record of actual requests");
  return lines;
}
