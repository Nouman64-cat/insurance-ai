// Run: node --test tests/   (the Docker image runs it too). Checks the translations without a browser:
//   * every key used in the source exists in English (so no raw "some.key" is ever shown to a customer);
//   * Urdu has exactly the same keys, and the same {placeholders}, as English.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === "node_modules" || f === ".next" ? [] : walk(p)) : [p]; });
const load = (file) => {
  const src = readFileSync(join(root, "lib/i18n", file), "utf8");
  const body = src.slice(src.indexOf("{", src.indexOf("= {") ) );
  const map = {};
  for (const m of body.matchAll(/"([^"]+)":\s*"((?:[^"\\]|\\.)*)"/g)) map[m[1]] = m[2];
  return map;
};
const en = load("en.ts"), ur = load("ur.ts");

test("Urdu has the same keys as English", () => {
  assert.deepEqual(Object.keys(en).filter((k) => !(k in ur)), [], "keys missing in ur.ts");
  assert.deepEqual(Object.keys(ur).filter((k) => !(k in en)), [], "keys only in ur.ts");
});

test("Urdu keeps the same {placeholders}", () => {
  const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const k of Object.keys(en)) assert.equal(ph(ur[k] ?? ""), ph(en[k]), `placeholders differ for ${k}`);
});

test("every translation key used in the source exists", () => {
  const files = walk(join(root, "app")).concat(walk(join(root, "components")), walk(join(root, "lib"))).filter((f) => /\.tsx?$/.test(f) && !f.includes("/i18n/"));
  const used = new Set(), dynamic = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\bt\(\s*"([^"]+)"/g)) used.add(m[1]);
    for (const m of src.matchAll(/\bt\(\s*`([^`]+)`/g)) dynamic.push(m[1]);
    for (const m of src.matchAll(/tOr\(\s*t,\s*`([^`]+)`/g)) dynamic.push(m[1]);
  }
  assert.deepEqual([...used].filter((k) => !(k in en)), [], "keys used but not defined");
  // dynamic keys: every prefix must have at least one entry, so a typo in the prefix is caught.
  for (const d of dynamic) {
    const prefix = d.split("${")[0];
    assert.ok(Object.keys(en).some((k) => k.startsWith(prefix)), `no keys under prefix "${prefix}" (from \`${d}\`)`);
  }
});

test("the dynamic key families are complete", () => {
  const families = {
    "policyStatus.": ["active", "reinstated", "grace_period", "lapsed", "cancelled", "pending_issuance", "issued", "expired", "matured", "surrendered", "unknown"],
    "claimStatus.": ["submitted", "in_review", "assessment", "documents_needed", "approved", "partially_approved", "declined", "settled", "closed"],
    "installment.": ["paid", "waived", "upcoming", "due_soon", "due_today", "grace", "past_grace"],
    "notice.": ["premium_overdue", "premium_due", "policy_lapsed", "policy_expiry", "policy_pending_issuance", "claim_submitted", "claim_in_review", "claim_documents_needed", "claim_assessment", "claim_approved", "claim_partially_approved", "claim_declined", "claim_settled", "claim_closed"],
  };
  for (const [prefix, names] of Object.entries(families)) for (const n of names) {
    if (prefix === "notice.") { assert.ok(`notice.${n}.title` in en && `notice.${n}.text` in en, `missing notice.${n}`); continue; }
    assert.ok(prefix + n in en, `missing ${prefix}${n}`);
  }
});
