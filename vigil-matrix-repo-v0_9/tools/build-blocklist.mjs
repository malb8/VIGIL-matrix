#!/usr/bin/env node
/*
 * VIGIL Matrix Lite - static blocklist builder (v0.9)
 *
 * Converts hosts-format blocklists (e.g. StevenBlack hosts, AdAway) into a
 * declarativeNetRequest static ruleset JSON that ships with the extension
 * (declared in manifest.json under declarative_net_request.rule_resources,
 * disabled by default, toggled from the options page).
 *
 * Usage:
 *   node tools/build-blocklist.mjs hosts1.txt [hosts2.txt ...] -o data/static-blocklist.json
 *   node tools/build-blocklist.mjs --from-classification -o data/static-blocklist.json
 *
 * Accepted input lines:
 *   0.0.0.0 tracker.example      (hosts format)
 *   127.0.0.1 tracker.example    (hosts format)
 *   tracker.example              (plain domain list)
 *   # comments and blank lines are ignored
 *
 * Output rules:
 *   action  : block
 *   priority: 5  (PRIORITY.STATIC_BLOCKLIST — below every matrix cell, so an
 *                 explicit allow in the matrix always overrides the list)
 *   types   : all subresource types, main_frame excluded so navigating to a
 *             listed domain still works (uMatrix-style, not uBO-style)
 *   domains : chunked 1000 per rule to keep the rule count tiny
 *
 * Notes:
 * - Chrome guarantees 30,000 enabled static rules per extension (with a
 *   larger shared pool); domain-chunked rules stay far below that.
 * - IDN domains are punycoded; invalid entries are skipped with a warning.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const STATIC_BLOCKLIST_PRIORITY = 5;
const CHUNK_SIZE = 1000;
const ALL_SUBRESOURCE_TYPES = [
  "script", "xmlhttprequest", "sub_frame", "image", "stylesheet",
  "font", "media", "websocket", "ping", "object", "other"
];

const here = dirname(fileURLToPath(import.meta.url));

function toAsciiDomain(domain) {
  const url = new URL(`http://${String(domain).trim()}`);
  return url.hostname.replace(/\.$/, "");
}

function parseHostsText(text) {
  const domains = new Set();
  let skipped = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    // "0.0.0.0 domain" / "127.0.0.1 domain" / bare "domain"
    const candidate = /^\d+\.\d+\.\d+\.\d+$/.test(tokens[0]) || tokens[0] === "::1" || tokens[0] === "::"
      ? tokens[1]
      : tokens[0];
    if (!candidate) continue;
    if (candidate === "localhost" || candidate.endsWith(".localhost")) continue;
    try {
      const ascii = toAsciiDomain(candidate);
      if (!ascii.includes(".")) continue; // skip bare hostnames
      domains.add(ascii);
    } catch (_) {
      skipped += 1;
    }
  }
  return { domains, skipped };
}

function buildRules(domains) {
  const sorted = Array.from(domains).sort();
  const rules = [];
  for (let i = 0; i < sorted.length; i += CHUNK_SIZE) {
    rules.push({
      id: rules.length + 1,
      priority: STATIC_BLOCKLIST_PRIORITY,
      action: { type: "block" },
      condition: {
        requestDomains: sorted.slice(i, i + CHUNK_SIZE),
        resourceTypes: ALL_SUBRESOURCE_TYPES
      }
    });
  }
  return rules;
}

function main(argv) {
  const args = argv.slice(2);
  let output = join(here, "..", "data", "static-blocklist.json");
  const inputs = [];
  let fromClassification = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" || args[i] === "--output") output = args[++i];
    else if (args[i] === "--from-classification") fromClassification = true;
    else inputs.push(args[i]);
  }

  const domains = new Set();
  let skipped = 0;

  if (fromClassification) {
    const classification = JSON.parse(readFileSync(join(here, "..", "data", "domain-classification.json"), "utf8"));
    for (const d of classification.trackerDomains || []) domains.add(d);
    console.log(`Loaded ${domains.size} tracker domains from data/domain-classification.json`);
  }

  for (const input of inputs) {
    const parsed = parseHostsText(readFileSync(input, "utf8"));
    for (const d of parsed.domains) domains.add(d);
    skipped += parsed.skipped;
    console.log(`Parsed ${input}: ${parsed.domains.size} domains (${parsed.skipped} skipped)`);
  }

  if (domains.size === 0) {
    console.error("No domains found. Pass hosts files and/or --from-classification.");
    process.exit(1);
  }

  const rules = buildRules(domains);
  writeFileSync(output, JSON.stringify(rules, null, 2) + "\n");
  console.log(`Wrote ${rules.length} DNR rule(s) covering ${domains.size} domains to ${output}`);
  if (skipped) console.log(`Skipped ${skipped} unparseable line(s).`);
}

main(process.argv);
