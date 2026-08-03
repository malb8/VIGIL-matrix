/*
 * VIGIL Matrix Lite - "My rules" text format (v0.9)
 *
 * Pure module shared by the options page and the node test suite.
 *
 * A human-readable, diffable, version-controllable representation of the
 * complete committed policy, in the spirit of uMatrix's "My rules" pane.
 *
 * Grammar (one statement per line, '#' starts a comment):
 *
 *   <scope> <target> <type> <action>
 *       scope  : "*" (global) | registrable domain | hostname
 *       target : "*" (all hosts) | registrable domain | hostname
 *       type   : "*" | script | xhr | frame | image | css | font | media | cookie
 *       action : block | allow            (cookie: block only)
 *
 *   switch: <name> <scope> on|off
 *       name   : matrix-off | no-inline-script | no-worker |
 *                strip-referrer | https-upgrade
 *
 *   setting: default-mode open|relaxed|hard
 *   setting: default-deny on|off      (legacy alias: on -> hard, off -> open)
 *   setting: blocklist on|off
 *
 * Examples:
 *   * doubleclick.net * block          # block everything from doubleclick
 *   news.example * script block        # block all scripts on news.example
 *   news.example cdn.example script allow
 *   news.example widget.example cookie block
 *   switch: no-inline-script bank.example on
 *   setting: default-mode relaxed
 *
 * IDN input is punycoded automatically. "off" switch lines and "noop" cells
 * are simply absent from the canonical serialization.
 */

import { toAsciiDomain } from "./domains.js";
import {
  MATRIX_TYPES, SWITCH_NAMES, DEFAULT_MODES,
  GLOBAL_SCOPE, TARGET_WILDCARD, TYPE_WILDCARD,
  validateAction
} from "./dnrCompiler.js";

// Short aliases used in the text format <-> internal matrix type names.
const TYPE_ALIASES = {
  xhr: "xmlhttprequest",
  frame: "sub_frame",
  css: "stylesheet"
};
const TYPE_SHORT = {
  xmlhttprequest: "xhr",
  sub_frame: "frame",
  stylesheet: "css"
};

function parseType(token) {
  if (token === TYPE_WILDCARD) return TYPE_WILDCARD;
  const type = TYPE_ALIASES[token] || token;
  if (!MATRIX_TYPES.includes(type)) throw new Error(`unknown type "${token}"`);
  return type;
}

function shortType(type) {
  return TYPE_SHORT[type] || type;
}

function parseHostToken(token, what) {
  if (token === "*") return "*";
  try {
    return toAsciiDomain(token);
  } catch (_) {
    throw new Error(`invalid ${what} "${token}"`);
  }
}

function parseOnOff(token, what) {
  if (token === "on" || token === "true") return true;
  if (token === "off" || token === "false") return false;
  throw new Error(`${what} must be "on" or "off", got "${token}"`);
}

/* ------------------------------------------------------------------ *
 * Parse
 * ------------------------------------------------------------------ */

/*
 * Returns { globalPolicy, sitePolicies, switches, settings, errors }.
 * `errors` is an array of { line, text, message }; the rest reflects only
 * the lines that parsed cleanly, so callers should refuse to apply when
 * errors is non-empty.
 */
export function parseRulesText(text) {
  const globalPolicy = {};
  const sitePolicies = {};
  const switches = {};
  const settings = {};
  const errors = [];

  const lines = String(text || "").split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;
    const lineNo = index + 1;
    try {
      const tokens = line.split(/\s+/);

      if (tokens[0] === "setting:") {
        if (tokens.length !== 3) throw new Error("setting lines take exactly 2 arguments");
        const name = tokens[1];
        const value = tokens[2];
        if (name === "default-mode") {
          if (!DEFAULT_MODES.includes(value)) throw new Error(`default-mode must be ${DEFAULT_MODES.join("|")}, got "${value}"`);
          settings.defaultMode = value;
        } else if (name === "default-deny") {
          // Legacy alias: keep old exports parseable. on -> hard, off -> open.
          settings.defaultMode = parseOnOff(value, "setting value") ? "hard" : "open";
        } else if (name === "blocklist") {
          settings.blocklistEnabled = parseOnOff(value, "setting value");
        } else {
          throw new Error(`unknown setting "${name}"`);
        }
        return;
      }

      if (tokens[0] === "switch:") {
        if (tokens.length !== 4) throw new Error("switch lines take exactly 3 arguments");
        const name = tokens[1];
        if (!SWITCH_NAMES.includes(name)) throw new Error(`unknown switch "${name}"`);
        const scope = parseHostToken(tokens[2], "switch scope");
        const on = parseOnOff(tokens[3], "switch value");
        if (on) {
          switches[scope] ||= {};
          switches[scope][name] = true;
        } else if (switches[scope]) {
          delete switches[scope][name];
          if (Object.keys(switches[scope]).length === 0) delete switches[scope];
        }
        return;
      }

      if (tokens.length !== 4) throw new Error("matrix lines are: <scope> <target> <type> <action>");
      const scope = parseHostToken(tokens[0], "scope");
      const target = parseHostToken(tokens[1], "target");
      const type = parseType(tokens[2]);
      const action = tokens[3];
      validateAction(type, action, false);

      const policy = scope === GLOBAL_SCOPE ? globalPolicy : (sitePolicies[scope] ||= {});
      policy[target] ||= {};
      policy[target][type] = action;
    } catch (error) {
      errors.push({ line: lineNo, text: raw.trim(), message: String(error?.message || error) });
    }
  });

  return { globalPolicy, sitePolicies, switches, settings, errors };
}

/* ------------------------------------------------------------------ *
 * Serialize / canonical lines / diff
 * ------------------------------------------------------------------ */

function matrixLines(scope, targetPolicy) {
  const lines = [];
  for (const [target, typePolicies] of Object.entries(targetPolicy || {})) {
    for (const [type, action] of Object.entries(typePolicies || {})) {
      if (action !== "block" && action !== "allow") continue;
      lines.push(`${scope} ${target} ${shortType(type)} ${action}`);
    }
  }
  return lines;
}

/*
 * Canonical, sorted line list for a policy state. Two states are equal
 * exactly when their canonical lines are equal, which makes diffing and
 * version control trivial.
 */
export function canonicalLines({ globalPolicy, sitePolicies, switches, settings }) {
  const lines = [];
  // Accept both the new shape (settings.defaultMode) and legacy state carrying
  // a boolean defaultDeny. "open" is the default, so it stays absent — mirroring
  // how "off" switches and "noop" cells never appear in the canonical form.
  const mode = DEFAULT_MODES.includes(settings?.defaultMode)
    ? settings.defaultMode
    : (settings?.defaultDeny ? "hard" : "open");
  if (mode !== "open") lines.push(`setting: default-mode ${mode}`);
  if (settings?.blocklistEnabled) lines.push("setting: blocklist on");
  for (const [scope, flags] of Object.entries(switches || {})) {
    for (const [name, on] of Object.entries(flags || {})) {
      if (on) lines.push(`switch: ${name} ${scope} on`);
    }
  }
  lines.push(...matrixLines(GLOBAL_SCOPE, globalPolicy || {}));
  for (const [scope, policy] of Object.entries(sitePolicies || {})) {
    lines.push(...matrixLines(scope, policy));
  }
  return lines.sort();
}

export function serializeRulesText(state) {
  const lines = canonicalLines(state);
  const header = [
    "# VIGIL Matrix Lite rules",
    "# <scope> <target> <type> <action> | switch: <name> <scope> on | setting: <name> on",
    "# types: * script xhr frame image css font media cookie",
    ""
  ];
  return header.concat(lines).join("\n") + "\n";
}

/* Line-set diff between two states: { added, removed } (sorted arrays). */
export function diffRules(currentState, nextState) {
  const current = new Set(canonicalLines(currentState));
  const next = new Set(canonicalLines(nextState));
  return {
    added: [...next].filter((l) => !current.has(l)).sort(),
    removed: [...current].filter((l) => !next.has(l)).sort()
  };
}
