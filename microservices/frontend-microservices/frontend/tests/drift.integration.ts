// Frontend-to-backend integration test of the Drift Monitor page. It runs the page's own module (lib/evalDrift.ts) under node against the live gateway:
// overview, queue and filters, one item with its history, every review action with its refusals (no reason, no expected value, wrong order),
// the prepared draft, scans, the watched items with their versions, the knowledge-base freshness, and refusal without sign-in.
//   python evals/frontend/run_drift_integration.py      (loads a few findings first; review items can never be deleted, so they use their own dataset name)
import api from "@/app/services/api";
import { decide, getDraft, getItem, getKnowledge, getOverview, getRegistry, getVersions, listItems, listScans, parseExpected } from "@/lib/evalDrift";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== undefined ? `\n       ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 500)}` : ""}`);
}
async function rejection(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { const d = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail; return d ? JSON.stringify(d) : e instanceof Error ? e.message : String(e); }
}

async function main(): Promise<number> {
  const TAG = process.env.DRIFT_TAG as string;
  check("expected values typed by a reviewer: JSON stays JSON, text stays text, empty is nothing", JSON.stringify(parseExpected('{"a":1}')) === '{"a":1}' && JSON.stringify(parseExpected("hello")) === '{"text":"hello"}' && parseExpected("  ") === null && JSON.stringify(parseExpected("5")) === '{"value":5}');

  const anon = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/eval/drift/overview`);
  check("without signing in the page is refused", anon.status === 401, anon.status);

  api.defaults.headers.common["Authorization"] = `Bearer ${process.env.DRIFT_TOKEN}`;
  const ov = await getOverview();
  check("the overview counts items needing a decision and shows the last scan", ov.open >= 3 && !!ov.last_scan?.scan_id.includes(TAG), ov);

  const mine = (await listItems({ state: "active", q: TAG })).items;
  check("the queue lists the loaded findings, open", mine.length === 3 && mine.every((i) => i.state === "open"), mine.map((i) => i.state));
  check("filtering by kind narrows the queue", (await listItems({ state: "active", kind: "proposal", q: TAG })).items.length === 1);
  check("filtering by severity narrows the queue", (await listItems({ state: "active", severity: "high", q: TAG })).items.every((i) => i.severity === "high"));
  const rule = mine.find((i) => i.kind === "rule_changed")!;
  const prop = mine.find((i) => i.kind === "proposal")!;
  const stale = mine.find((i) => i.kind === "unconfirmed")!;
  check("a suggested case carries no input and no expected value", prop.expected === null && !prop.detail.proposed_input);

  check("deciding before starting the review is refused", !!(await rejection(() => decide(rule.id, "accept", "ok", { v: 1 }))));
  check("start puts it in review", (await decide(rule.id, "start")).state === "in_review");
  check("a decision without a reason is refused", !!(await rejection(() => decide(rule.id, "dismiss", "  "))));
  check("accepting without an expected value written by the reviewer is refused", !!(await rejection(() => decide(rule.id, "accept", "the rule is right"))));
  const accepted = await decide(rule.id, "accept", "the rule is right", parseExpected('{"premium": 1200}')!);
  check("accept with a reason and an expected value is recorded as the reviewer's", accepted.state === "accepted" && accepted.expected_source === "reviewer" && accepted.decision_note === "the rule is right", accepted);
  const draft = await getDraft(rule.id);
  check("the prepared draft carries the reviewer's expected value and no invented input", (draft.draft.expected as { premium: number }).premium === 1200 && draft.draft.expected_source === "reviewer", draft);
  check("an item that is not accepted has no draft", !!(await rejection(() => getDraft(stale.id))));
  const detail = await getItem(rule.id);
  check("the item's history lists every step", detail.history.map((h) => h.to).join(">") === "open>in_review>accepted", detail.history);
  check("a decided item cannot be decided again", !!(await rejection(() => decide(rule.id, "dismiss", "x"))));

  check("dismiss needs a reason and then closes the item", (await decide(stale.id, "dismiss", "not relevant to this product")).state === "dismissed");
  check("a dismissed item can be reopened", (await decide(stale.id, "reopen")).state === "open");
  await decide(stale.id, "dismiss", "closing the test item");
  await decide(prop.id, "start");
  check("rejecting a suggestion needs only a reason", (await decide(prop.id, "reject", "not a case worth keeping")).state === "rejected");
  check("decided items leave the active queue but stay findable", (await listItems({ state: "active", q: TAG })).items.length === 0 && (await listItems({ state: "accepted", q: TAG })).items.length === 1);

  const scans = await listScans();
  check("the scans tab lists the stored scan", scans.scans.some((s) => s.scan_id.includes(TAG)), scans.scans.map((s) => s.scan_id));
  const reg = await getRegistry();
  check("the watched items cover calculations, plans, rules, workflows and templates", ["calc", "plan", "rule", "workflow", "template"].every((t) => reg.some((i) => i.type === t)), Array.from(new Set(reg.map((i) => i.type))));
  const premium = reg.find((i) => i.key === "calc:premium")!;
  const vs = await getVersions("calc:premium");
  check("an item's versions and dependent cases can be read", vs.versions.length >= 1 && premium.dependent_cases === vs.dependents.length, vs);
  const kb = await getKnowledge();
  check("the knowledge-base view lists the templates with the version the assistant knows", kb.length >= 2 && kb.every((r) => typeof r.current === "boolean"), kb);
  console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
  return failures === 0 ? 0 : 1;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(2); });
