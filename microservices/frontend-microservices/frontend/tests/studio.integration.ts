// Frontend-to-backend integration test of the Evaluation Studio. It runs the studio's own data module (lib/evalStudio.ts, with the existing drift, benchmark and cost modules it builds on) under
// node against a live gateway, then renders the studio's own views with what the real API returned and checks what a person would read.
//   python evals/frontend/run_studio_integration.py
// Two suites, chosen by STUDIO_SUITE:
//   writes  against the ISOLATED evaluation stack, in a world the test builds (a dataset, a changed rule, review items, runs on both sides of the change): the map, the search, the change
//           impact end to end with its approval decisions, executions and the replay of a trace
//   reads   against the working stack, changing nothing: the same views drawn from the real datasets, rules, runs, traces and costs
import { createElement } from "react";
import api from "@/app/services/api";
import { getCostOverview } from "@/lib/evalCosts";
import { getBreakdown, getResult, listBenchmarks } from "@/lib/evalBenchmarks";
import { decide, getDraft } from "@/lib/evalDrift";
import * as S from "@/lib/evalStudio";
import CaseHeatmap from "@/components/studio/CaseHeatmap";
import { COMMANDS, hitHref } from "@/components/studio/CommandPalette";
import EcosystemMap from "@/components/studio/EcosystemMap";
import { FinderView, ImpactView, ago, filterChanges, nextAction } from "@/components/studio/ImpactExplorer";
import { CompareBody, RunList, runLabel } from "@/components/studio/CompareRunsView";
import { RunSummaryBody } from "@/components/studio/RunSummary";
import AnalyticsView, { AnalyticsBody, drill } from "@/components/studio/AnalyticsView";
import SavedViews, { SavedViewsPanel } from "@/components/studio/SavedViews";
import * as V from "@/lib/savedViews";
import { ExecutionsView } from "@/components/studio/InvestigateView";
import { ModeBanner, overlaysFor, tally } from "@/components/studio/SimulateView";
import { HealthStrip } from "@/components/studio/ExploreView";
import { StatePill } from "@/components/studio/StudioShell";
import { Headline, Primer } from "@/components/studio/ExploreView";
import TraceTimeline from "@/components/studio/TraceTimeline";

const { renderToStaticMarkup } = require("react-dom/server") as { renderToStaticMarkup: (element: unknown) => string };
const html = (el: unknown) => renderToStaticMarkup(el);
const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== undefined ? `\n       ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 500)}` : ""}`);
}
async function rejection(fn: () => Promise<unknown>): Promise<string | null> { try { await fn(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); } }
const noop = () => undefined;

function pure(): void {
  const g = { nodes: [
    { id: "rules:rule", kind: "rules", label: "Rules", layer: 0, order: 0, health: { state: "ok" as const, reason: "x" }, stats: {}, badge: null, active: false },
    { id: "rules:plan", kind: "rules", label: "Plans", layer: 0, order: 1, health: { state: "warn" as const, reason: "x" }, stats: {}, badge: null, active: false },
    { id: "dataset:a", kind: "dataset", label: "A", layer: 1, order: 0, health: { state: "bad" as const, reason: "x" }, stats: {}, badge: null, active: false },
    { id: "harness", kind: "harness", label: "Harness", layer: 2, order: 0, health: { state: "unknown" as const, reason: "x" }, stats: {}, badge: null, active: false }] };
  const a = S.layoutGraph(g), b = S.layoutGraph(g);
  check("the layout is deterministic: the same graph is always drawn the same way", JSON.stringify(a.nodes.map((n) => [n.id, n.x, n.y])) === JSON.stringify(b.nodes.map((n) => [n.id, n.x, n.y])));
  check("nodes of a layer share a column, columns go left to right in layer order, and no two nodes overlap", a.byId["rules:rule"].x === a.byId["rules:plan"].x && a.byId["rules:rule"].x < a.byId["dataset:a"].x && a.byId["dataset:a"].x < a.byId["harness"].x
    && a.nodes.every((n, i) => a.nodes.every((m, j) => i === j || n.x + S.NODE_W <= m.x || m.x + S.NODE_W <= n.x || n.y + S.NODE_H <= m.y || m.y + S.NODE_H <= n.y)));
  check("everything fits inside the canvas it reports", a.nodes.every((n) => n.x >= 0 && n.y >= 0 && n.x + S.NODE_W <= a.width && n.y + S.NODE_H <= a.height));
  check("a link goes from the right of the left node to the left of the right one, and backwards links curve the other way", S.edgePath(a.byId["dataset:a"], a.byId["harness"]).startsWith(`M ${a.byId["dataset:a"].x + S.NODE_W} `) && S.edgePath(a.byId["harness"], a.byId["dataset:a"]).startsWith(`M ${a.byId["harness"].x} `));
  const edges = [{ from: "rules:rule", to: "dataset:a", kind: "depends", weight: 3, label: "" }, { from: "dataset:a", to: "harness", kind: "feeds", weight: 2, label: "" }, { from: "rules:plan", to: "dataset:a", kind: "depends", weight: 1, label: "" }];
  const near = S.neighbourhood({ edges }, "dataset:a");
  check("hovering a node lights its own links and neighbours, nothing else", near.nodes.size === 4 && near.edges.size === 3 && S.neighbourhood({ edges }, "harness").nodes.size === 2);
  check("no link flows unless a job is running; when one is, the dataset it uses, the harness and the outcome links flow", S.activeLinks({ ...g, edges, health: {}, layers: [], as_of: "", note: "", running: [] }).size === 0
    && S.activeLinks({ ...g, edges, health: {}, layers: [], as_of: "", note: "", running: [{ dataset: "a", models: ["openai/x"] }] }).has(1));
  check("the worst health of a set of nodes", S.worstHealth(g.nodes) === "bad" && S.worstHealth(g.nodes.filter((n) => n.health.state !== "bad")) === "warn" && S.worstHealth([]) === "unknown");
  check("addresses are short: only what differs from the default is written", S.studioHref() === "/super-admin/evaluation" && S.studioHref({ mode: "simulate", dataset: "d" }) === "/super-admin/evaluation?mode=simulate&dataset=d" && S.studioHref({ tool: "costs", extra: { view: "usage" } }) === "/super-admin/evaluation?tool=costs&view=usage" && S.studioHref({ mode: "explore", lens: "map" }) === "/super-admin/evaluation");
  const steps = S.traceSteps({ trace: { turns: [{ index: 1, message: "hi", reply: "hello", latency_ms: 900 }], messages: [{ type: "human", content: "hi" }, { type: "ai", content: "", tool_calls: [{ name: "list_leads", args: { a: 1 } }] }, { type: "tool", name: "list_leads", result: { n: 2 } }, { type: "ai", content: "hello" }] },
    trace_summary: { specialist: "claims" }, model: "openai/gpt-4o-mini", latency_ms: 1200, input_tokens: 100, output_tokens: 20, cost_usd: 0.001, judge_cost_usd: 0.0005 });
  check("a stored trace becomes steps in the order they happened: routing, user, tool call, tool result, answer, then the model's usage", steps.map((s) => s.lane).join() === "agent,user,tool,result,agent,usage" && steps[0].title.includes("claims") && steps[2].title === "Calls list_leads" && steps[steps.length - 1].title.includes("100 tokens in"), steps.map((s) => s.title));
  check("the turn's latency attaches to the agent's answer, and nothing else gets a timing it does not have", steps.filter((s) => typeof s.ms === "number").length === 1 && steps.find((s) => typeof s.ms === "number")!.text === "hello");
  check("a result with no stored trace is a single usage step (the replay says there is nothing to replay)", S.traceSteps({ trace: null, model: null, latency_ms: null, input_tokens: null, output_tokens: null, cost_usd: null, judge_cost_usd: null }).length === 1);
  // ── saved views ──
  const at = new Date("2026-10-24T10:00:00Z");
  let vs = V.withView([], "Failing, 30 days", "/super-admin/evaluation?mode=investigate&sub=executions&st=failed&idays=30", at);
  vs = V.withView(vs, "Cost", "/super-admin/evaluation?mode=investigate&sub=compare", at);
  check("a saved view keeps its name and address, the newest first", vs.length === 2 && vs[0].name === "Cost" && vs[1].href.includes("idays=30"), vs);
  check("saving under a name already used replaces it (in any letter case) instead of listing it twice", V.withView(vs, "cost", "/super-admin/evaluation?mode=simulate", at).length === 2 && V.withView(vs, "cost", "/super-admin/evaluation?mode=simulate", at)[0].href.endsWith("mode=simulate"));
  check("an empty name and an address outside the studio are not saved", V.withView(vs, "  ", "/super-admin/evaluation?x=1", at) === vs && V.withView(vs, "x", "https://evil.example/", at) === vs && V.withView(vs, "x", "/super-admin/evaluationx", at) === vs);
  check("no more than the limit are kept, the oldest dropped", Array.from({ length: 25 }, (_, i) => i).reduce((l, i) => V.withView(l, `v${i}`, "/super-admin/evaluation", at), [] as V.SavedView[]).length === V.MAX_VIEWS);
  check("a stored list is read back only when it is well formed: garbage, a non-list and an off-site address yield nothing", V.parseViews("not json").length === 0 && V.parseViews('{"a":1}').length === 0 && V.parseViews(null).length === 0
    && V.parseViews(JSON.stringify([{ name: "x", href: "https://evil.example/", saved_at: "now" }, { name: "ok", href: "/super-admin/evaluation?mode=simulate", saved_at: "now" }])).length === 1 && V.parseViews(JSON.stringify(vs)).length === 2);
  check("a view is removed by name", V.withoutView(vs, "Cost").length === 1 && V.withoutView(vs, "nothing").length === 2);
  check("without browser storage nothing breaks: reading gives an empty list, and writing says it did not work", V.loadViews().length === 0 && V.storeViews(vs) === false);
  const panel = html(createElement(SavedViewsPanel, { views: vs, name: "", onName: noop, onSave: noop, onOpen: noop, onDelete: noop, onCopy: noop, note: null }));
  const panelText = text(panel);
  check("the saved-views panel lists each view, can delete it, saves under a typed name (disabled while empty) and copies a link", panel.includes('data-testid="saved-views-list"') && panelText.includes("Failing, 30 days") && panelText.includes("Cost") && panel.includes('aria-label="Delete the saved view Cost"')
    && /<button[^>]*disabled[^>]*>\s*Save/.test(panel) && panelText.includes("Copy a link to this page") && panelText.includes("Stored in this browser only"), panelText.slice(0, 300));
  check("with none saved the panel says so", text(html(createElement(SavedViewsPanel, { views: [], name: "", onName: noop, onSave: noop, onOpen: noop, onDelete: noop, onCopy: noop, note: "This browser would not store it" }))).includes("No saved views yet") );
  check("the Views button is closed to begin with, and says what it opens", typeof SavedViews === "function");
  const events = [1, 2, 3, 4].map((i) => ({ seq: i, at: "", kind: "case", message: "", data: { model: i < 4 ? "openai/gpt-4o-mini" : "gemini/g", status: i === 2 ? "failed" : "passed", cost_usd: 0.01 } }));
  const t = tally(events);
  check("a running job's event stream is counted per provider", t.done === 4 && t.passed === 3 && t.failed === 1 && Math.abs(t.spent - 0.04) < 1e-9 && t.byProvider.openai.done === 3 && t.byProvider.gemini.done === 1);
  const job = { id: "j", state: "running", config: { dataset: "a", models: [] }, estimate: {}, progress: { planned: 10 }, cancel_requested: false, run_id: null, error: null, created_at: "", started_at: null, finished_at: null } as unknown as Parameters<typeof overlaysFor>[0];
  const o = overlaysFor(job, t);
  check("the map's nodes light up from the counts: the harness shows 4 / 10, each provider its own progress, the dataset that is being evaluated", o.harness.text.startsWith("4 / 10") && o["provider:openai"].text.includes("3 done") && !!o["dataset:a"] && !!o.costs);
  check("a finished or absent job lights nothing", Object.keys(overlaysFor({ ...(job as object), state: "succeeded" } as typeof job, t)).length === 0 && Object.keys(overlaysFor(null, t)).length === 0);
  check("the run banner says free simulation for scripted models and real run (spends money) for GPT, Gemini or Claude", text(html(createElement(ModeBanner, { models: ["mock/mock-oracle"] }))).includes("Free simulation") && text(html(createElement(ModeBanner, { models: ["mock/mock-oracle", "openai/gpt-4o-mini"] }))).includes("Real run")
    && text(html(createElement(ModeBanner, { models: [] }))).includes("Choose the models"));
  check("every command in the palette leads to an address in the studio or the templates route", COMMANDS.every((c) => c.href.startsWith("/super-admin/evaluation") || c.href === S.TEMPLATES_ROUTE) && new Set(COMMANDS.map((c) => c.id)).size === COMMANDS.length);
  const hits: Record<string, string> = { dataset: hitHref("dataset", { id: "d", title: "", sub: "" }), case: hitHref("case", { id: "C", title: "", sub: "", dataset: "d" }), benchmark: hitHref("benchmark", { id: "b", title: "", sub: "" }), run: hitHref("run", { id: "r", title: "", sub: "" }),
    model: hitHref("model", { id: "m", title: "", sub: "", provider: "openai" }), rule: hitHref("rule", { id: "rule:X", title: "", sub: "" }), finding: hitHref("finding", { id: "f", title: "", sub: "" }) };
  check("every kind of search hit leads somewhere in the studio with the right state in the address", hits.dataset.includes("node=dataset%3Ad") && hits.case.includes("tool=datasets") && hits.case.includes("dataset=d") && hits.benchmark.includes("bench=b") && hits.run.includes("ir=r")
    && hits.model.includes("node=provider%3Aopenai") && hits.rule.includes("lens=impact") && hits.rule.includes("impact=rule%3AX") && hits.finding.includes("tool=drift"), hits);
}

async function writes(): Promise<void> {
  const slug = process.env.STUDIO_SLUG as string, key = process.env.STUDIO_KEY as string, tag = process.env.STUDIO_TAG as string, drift = (process.env.STUDIO_DRIFT as string).split(",");
  const anon = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/eval/studio/graph`);
  check("without signing in the studio's data is refused", anon.status === 401, anon.status);
  api.defaults.headers.common["Authorization"] = `Bearer ${process.env.STUDIO_TOKEN}`;
  pure();

  // ── the map ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const g = await S.getGraph();
  const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  const d = byId[`dataset:${slug}`];
  check("the world's dataset is on the map with its health, version and cases, from the platform's own records", !!d && d.health.state === "bad" && d.stats.latest_version === "1.0.1" && d.stats.cases === 3 && d.stats.unconfirmed === 1, d);
  check("a running job lights the harness, and the links of a running evaluation are marked as flowing", byId.harness.active && S.activeLinks(g).size > 0);
  const layout = S.layoutGraph(g);
  check("the real graph lays out with every node placed and every link between placed nodes", layout.nodes.length === g.nodes.length && g.edges.every((e) => layout.byId[e.from] && layout.byId[e.to]));
  const mapHtml = html(createElement(EcosystemMap, { graph: g, selected: `dataset:${slug}`, onSelect: noop, overlays: { harness: { text: "5 / 20 done", tone: "run" as const } } }));
  const mapText = text(mapHtml);
  check("the map draws every node as a keyboard-reachable button whose label says its health and why", g.nodes.every((n) => mapHtml.includes(`data-node="${n.id}"`)) && mapHtml.includes(`aria-label="${d.label}: failing.`) && (mapHtml.match(/tabindex="0"/g) ?? []).length >= g.nodes.length, mapHtml.slice(0, 300));
  check("the selected node is marked, the running harness shows its progress and pulses, and a narrow screen gets the list", mapHtml.includes("is-selected") && mapText.includes("5 / 20 done") && mapHtml.includes("studio-ring") && mapHtml.includes('data-testid="map-list"'));
  const onlyBad = html(createElement(EcosystemMap, { graph: g, selected: null, onSelect: noop, only: new Set(["bad"]) as Set<S.Health> }));
  check("the health filter keeps only the nodes in that state", g.nodes.filter((n) => n.health.state === "bad").every((n) => onlyBad.includes(`data-node="${n.id}"`)) && g.nodes.filter((n) => n.health.state === "ok").every((n) => !onlyBad.includes(`data-node="${n.id}"`)));
  const strip = text(html(createElement(HealthStrip, { graph: g, only: new Set<S.Health>(), onToggle: noop })));
  check("the health strip counts each state, and the header pill names the worst", /\d+ failing/.test(strip) && text(html(createElement(StatePill, { graph: g }))).includes("failing"));
  const obs = await S.getObserved();
  check("what the agent was observed doing lists the specialist and tools the runs used, and says it is only what was observed", obs.specialists.some((x) => x.name === "underwriting") && obs.tools.some((x) => x.name === "record_lead" && x.executions >= 2) && obs.note.includes("no catalogue"));

  // ── search ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const found = await S.searchStudio(tag);
  check("search finds the dataset, the rule and the review items by what they are called", ["dataset", "rule", "finding"].every((k) => found.groups.some((x) => x.kind === k)), found.groups.map((x) => x.kind));
  check("every hit leads to a real place in the studio", found.groups.every((gp) => gp.items.every((i) => hitHref(gp.kind, i).startsWith("/super-admin/evaluation"))));
  check("a case is found by its key and opens its dataset in the manager", (await S.searchStudio("SW-A")).groups.some((gp) => gp.kind === "case" && gp.items.some((i) => i.dataset === slug && hitHref("case", i).includes(`dataset=${slug}`))));
  check("a one-letter search finds nothing and asks nothing of the database", (await S.searchStudio("t")).total === 0);

  // ── change impact, end to end ─────────────────────────────────────────────────────────────────────────────────────
  const cands = await S.listImpactCandidates();
  check("the changed rule is offered, with its dependents and its open review items", cands.some((c) => c.key === key && c.version === 2 && c.open_findings === 1), cands.slice(0, 3));
  const cl = (k: string, type: string, o: Partial<S.ImpactCandidate> = {}): S.ImpactCandidate => ({ key: k, title: k, type, version: 1, changed_at: null, dependent_cases: 0, open_findings: 0, ...o });
  const pool = [cl("template:lead", "template", { title: "Lead acquisition form", changed_at: "2026-10-20T10:00:00", open_findings: 3, dependent_cases: 2 }), cl("rule:kyc", "rule", { title: "KYC rules", changed_at: "2026-10-22T10:00:00", dependent_cases: 9 }),
    cl("plan:term", "plan", { title: "Term Life Secure", dependent_cases: 4 }), cl("template:proposal", "template", { title: "Proposal", changed_at: "2026-10-23T10:00:00" })];
  const names = (f: Parameters<typeof filterChanges>[1]) => filterChanges(pool, f).map((c) => c.key).join();
  check("the change finder narrows by text (name, key or type), by type and by 'needs review', each on its own and together", names({ q: "kyc", type: "", attention: false, sort: "recent" }) === "rule:kyc" && names({ q: "TEMPLATE", type: "", attention: false, sort: "recent" }).split(",").length === 2
    && names({ q: "", type: "plan", attention: false, sort: "recent" }) === "plan:term" && names({ q: "", type: "", attention: true, sort: "recent" }) === "template:lead" && names({ q: "form", type: "template", attention: true, sort: "recent" }) === "template:lead" && names({ q: "zzz", type: "", attention: false, sort: "recent" }) === "");
  check("changes needing review come first, then the most recently changed, then the never changed", names({ q: "", type: "", attention: false, sort: "recent" }) === "template:lead,template:proposal,rule:kyc,plan:term", names({ q: "", type: "", attention: false, sort: "recent" }));
  check("they can also be sorted by how many cases lean on them, or by name", names({ q: "", type: "", attention: false, sort: "cases" }).startsWith("rule:kyc,plan:term") && names({ q: "", type: "", attention: false, sort: "name" }) === "rule:kyc,template:lead,template:proposal,plan:term");
  const state = { q: "", type: "", attention: "", sort: "recent", setQ: noop, setType: noop, setAttention: noop, setSort: noop };
  const now = new Date("2026-10-24T12:00:00").getTime();
  check("times read as 'x ago' and nothing is shown for a change that never happened", ago("2026-10-24T11:59:40", now) === "just now" && ago("2026-10-24T11:30:00", now) === "30 min ago" && ago("2026-10-24T06:00:00", now) === "6 h ago" && ago("2026-10-20T12:00:00", now) === "4 days ago" && ago(null, now) === "");
  const fHtml = html(createElement(FinderView, { cands: pool, value: "", onPick: noop, state }));
  check("the finder renders one search combobox, filters with counts, and the changes as options with what is waiting", fHtml.includes('role="combobox"') && fHtml.includes('role="listbox"') && (fHtml.match(/role="option"/g) ?? []).length === 4 && text(fHtml).includes("Lead acquisition form") && text(fHtml).includes("3 waiting for review")
    && text(fHtml).includes("Needs review 1") && text(fHtml).includes("Templates 2") && text(fHtml).includes("4 items the evaluation watches"), text(fHtml).slice(0, 300));
  check("an empty registry says so, instead of an empty box", text(html(createElement(FinderView, { cands: [], value: "", onPick: noop, state }))).includes("Nothing is being watched yet"));
  let im = await S.getImpact(key);
  const own = () => im.suggested_updates.filter((u) => u.summary.includes(tag));
  check("the impact lists what changed, the two affected cases with how the latest real run did, and the suggestions the change caused", im.versions[0].diff.length === 3 && im.dependents.filter((x) => x.dataset === slug).map((x) => x.case_id).sort().join() === "SW-A,SW-B"
    && own().length === 2, im.stages);
  const act = nextAction(im);
  check("the change view says what to do next, from the recorded stages: review what waits, with the way to do it", !!act && act.step === 3 && /waiting for a decision/.test(act.text) && !act.href, act);
  check("it never claims a next step when nothing is waiting", nextAction({ ...im, stages: { ...im.stages, open_suggestions: 0 }, suggested_updates: im.suggested_updates.map((u) => ({ ...u, state: "rejected" })), dataset_versions: {}, regression: {} } as S.Impact) === null);
  const view1 = html(createElement(ImpactView, { impact: im, onDecide: noop, onOpenTrace: noop, onDraft: noop, draft: null }));
  const v1 = text(view1);
  check("the impact view shows all seven stages of the chain in order, each with its state, and the before and after of the change", ["stage-change", "stage-cases", "stage-suggestions", "stage-approval", "stage-versions", "stage-regression", "stage-impact"].every((s, i, a) => view1.includes(`data-testid="${s}"`) && (i === 0 || view1.indexOf(`data-testid="${s}"`) > view1.indexOf(`data-testid="${a[i - 1]}"`)))
    && v1.includes("− 10") && v1.includes("+ 15"), v1.slice(0, 300));
  check("the cases show how the latest real run did: SW-A failed, SW-B passed", view1.includes('data-case="SW-A"') && /data-case="SW-A"[^>]*>/.test(view1) && view1.match(/bg-red-50 text-red-700 border-red-200"[^>]*data-case="SW-A"/) !== null);
  check("the regression stage compares the same model before and after: 67% before, 67% after, cost per execution compared; and the new version published since is marked", v1.includes("openai/gpt-4o-mini") && v1.includes("after the change") && view1.includes('data-compare="openai/gpt-4o-mini"'));
  check("a review item that needs the reviewer's expected value can only be accepted after it is started, and with a reason and the expected value", !!(await rejection(() => decide(drift[1], "accept", "the rule is right", { v: 1 }))));
  const started = await decide(drift[1], "start");
  check("starting the review moves it to in review", started.state === "in_review");
  check("accepting without a reason is refused", !!(await rejection(() => decide(drift[1], "accept", "  ", { limit: 15 }))));
  check("accepting without the expected value the reviewer wrote is refused", !!(await rejection(() => decide(drift[1], "accept", "the new limit is right"))));
  const accepted = await decide(drift[1], "accept", "the new limit is right", { limit: 15 });
  check("accepting with a reason and the reviewer's own expected value is recorded as theirs", accepted.state === "accepted" && accepted.expected_source === "reviewer" && accepted.decision_note === "the new limit is right", accepted);
  im = await S.getImpact(key);
  const after = html(createElement(ImpactView, { impact: im, onDecide: noop, onOpenTrace: noop, onDraft: noop, draft: null }));
  check("the chain follows: the approval stage is done and the draft case can be prepared, with nothing written to the dataset", after.includes('data-testid="stage-approval" data-state="done"') && text(after).includes("Prepare draft") && im.principle.includes("Nothing here changes a case"), im.stages);
  const acc = im.suggested_updates.filter((u) => u.state === "accepted" && u.dataset);
  check("each accepted suggestion with a dataset links to that dataset in the dataset manager, and nothing is written by the link", acc.length > 0 && after.includes('data-testid="open-in-dataset-manager"') && acc.every((u) => after.includes(`tool=datasets&amp;dataset=${u.dataset}`)), acc.map((u) => u.dataset));
  const dr = await getDraft(drift[1]);
  check("the prepared draft carries the reviewer's expected value and no invented input", (dr.draft.expected as { limit: number }).limit === 15 && dr.draft.expected_source === "reviewer" && dr.draft.input === null, dr.draft);
  check("an item decided cannot be decided again", !!(await rejection(() => decide(drift[1], "dismiss", "x"))));
  const dismissed = await decide(drift[0], "dismiss", "the rule change was intended and the cases still hold");
  check("an acknowledgement (a change nobody must write an expected value for) can be dismissed with a reason alone", dismissed.state === "dismissed");
  check("an item that is not in the registry has no impact", !!(await rejection(() => S.getImpact("rule:does-not-exist"))));

  // ── executions ────────────────────────────────────────────────────────────────────────────────────────────────────
  const page = await S.listExecutions({ dataset: slug });
  check("executions across runs: six, newest first, the counts of each outcome and the filters to offer", page.total === 6 && page.by_status.passed === 4 && page.by_status.failed === 2 && page.results[0].dataset === slug && page.datasets.includes(slug), page.by_status);
  const exHtml = html(createElement(ExecutionsView, { page, status: "", onStatus: noop, model: "", onModel: noop, dataset: "", onDataset: noop, text: "", onText: noop, synthetic: false, onSynthetic: noop, offset: 0, onOffset: noop, onOpen: noop }));
  check("the executions page shows a chip per outcome with its count and a row per execution with its case, agent and tools", text(exHtml).includes("passed 4") && text(exHtml).includes("failed 2") && (exHtml.match(/data-testid="execution-row"/g) ?? []).length === 6 && text(exHtml).includes("underwriting") && text(exHtml).includes("record_lead"));
  const failedOnly = await S.listExecutions({ dataset: slug, status: "failed" });
  check("filtering by outcome keeps the other counts on the chips (so a person can switch back)", failedOnly.total === 2 && failedOnly.results.every((r) => r.status === "failed") && failedOnly.by_status.passed === 4);
  check("an unknown outcome is refused", !!(await rejection(() => S.listExecutions({ status: "magic" }))));
}

async function reads(): Promise<void> {
  api.defaults.headers.common["Authorization"] = `Bearer ${process.env.STUDIO_TOKEN}`;
  pure();
  const g = await S.getGraph();
  const kinds = new Set(g.nodes.map((n) => n.kind));
  check("the real ecosystem has the business rules, the datasets, the harness, the drift monitor, the agent, the providers, the judge, the results and the costs", ["rules", "dataset", "harness", "drift", "agent", "provider", "deepeval", "results", "costs"].every((k) => kinds.has(k)), Array.from(kinds));
  check("the health counts add up to the nodes, and every node explains its health", Object.values(g.health).reduce((a, b) => a + b, 0) === g.nodes.length && g.nodes.every((n) => n.health.reason.length > 3));
  check("the datasets on the map are the platform's real datasets", g.nodes.filter((n) => n.kind === "dataset").map((n) => n.stats.slug).includes("individual-single-turn"));
  const rules = g.nodes.filter((n) => n.kind === "rules");
  check("the business side is the change registry's real items, counted by type, linked to the datasets that depend on them by the declared dependencies", rules.length >= 3 && rules.reduce((a, n) => a + n.stats.items, 0) > 30 && g.edges.some((e) => e.kind === "depends" && e.weight > 0));
  const openai = byIdOf(g, "provider:openai");
  check("the OpenAI node reflects the real runs and says what its health rests on", !!openai && openai.stats.real_runs >= 3 && openai.stats.ran > 40 && openai.health.reason.length > 10 && openai.stats.spend_month_usd > 0, openai?.stats);
  check("scripted models are their own provider and are never called unhealthy for failing a quality bar", byIdOf(g, "provider:mock")?.health.state === "ok");
  const mapHtml = html(createElement(EcosystemMap, { graph: g, selected: null, onSelect: noop }));
  check("the real map renders every node", g.nodes.every((n) => mapHtml.includes(`data-node="${n.id}"`)));
  const obs = await S.getObserved();
  check("the observed agent has real specialists and tools from real traces, each with its executions", obs.specialists.length >= 1 && obs.tools.length >= 5 && obs.tools.every((t) => t.executions > 0) && obs.agent.executions > 100);

  const cands = await S.listImpactCandidates();
  check("the changed and depended-on items are offered, with templates that changed among them", cands.length > 0 && cands.some((c) => c.type === "template" && c.version! > 1) && cands.some((c) => c.dependent_cases > 0));
  const withDeps = cands.find((c) => c.dependent_cases > 0)!;
  const im = await S.getImpact(withDeps.key);
  check("an item cases depend on lists those cases with their dataset, version and severity", im.dependents.length === withDeps.dependent_cases || im.dependents.length >= 1, [im.dependents.length, withDeps.dependent_cases]);
  const imHtml = text(html(createElement(ImpactView, { impact: im, onDecide: noop, onOpenTrace: noop, onDraft: noop, draft: null })));
  check("the real impact view renders all seven stages", ["Change", "Affected cases", "Suggested updates", "Approval", "New dataset version", "Regression evaluation", "Quality & cost impact"].every((s) => imHtml.includes(s)) && imHtml.includes(im.item.title));
  const tpl = cands.find((c) => c.type === "template" && c.version! > 1)!;
  const tplImpact = await S.getImpact(tpl.key);
  check("a template that changed shows its before and after, and links to the template itself; no case is claimed to depend on it when none declares so", tplImpact.stages.change && tplImpact.versions[0].diff.length > 0 && text(html(createElement(ImpactView, { impact: tplImpact, onDecide: noop, onOpenTrace: noop, onDraft: noop, draft: null }))).includes("Open the template"));

  const page = await S.listExecutions({ limit: 50 });
  check("executions across the real runs add up: the chips' counts are the total", page.total === Object.values(page.by_status).reduce((a, b) => a + b, 0) && page.total > 100 && page.models.length >= 2, [page.total, page.by_status]);
  const failed = await S.listExecutions({ status: "failed", limit: 20 });
  check("only the failures, with the failing count unchanged by the filter", failed.results.length > 0 && failed.results.every((r) => r.status === "failed") && failed.total === page.by_status.failed);
  const traced = (await S.listExecutions({ limit: 200 })).results.find((r) => r.has_trace && r.tools.length > 0);
  check("some real executions have a stored trace to replay", !!traced);
  if (traced) {
    const r = await getResult(traced.result_id);
    const steps = S.traceSteps(r);
    check("the real trace becomes a timeline: the user, the agent, a tool call and its result in order, and the model's usage last", steps.length > 3 && steps[0].lane !== "usage" && steps[steps.length - 1].lane === "usage" && steps.some((s) => s.lane === "tool"), steps.map((s) => s.lane));
    const tl = text(html(createElement(TraceTimeline, { r })));
    check("the replay shows its controls, the lanes and the honest note about timings", tl.includes("Replay") && tl.includes("Play") && tl.includes("Tool call") && tl.includes("Per-tool timings are not recorded"), tl.slice(0, 200));
  }
  const benches = await listBenchmarks(20);
  const real = benches.find((b) => !b.synthetic);
  if (real) {
    const bd = await getBreakdown(real.benchmark_id);
    const hm = html(createElement(CaseHeatmap, { breakdown: bd, hidden: new Set<string>(), onOpen: noop }));
    check("a real benchmark's cases and models become a heatmap, the weakest cases first, each cell a button that opens a trace", hm.includes('data-testid="heatmap"') && (hm.match(/data-cell=/g) ?? []).length >= bd.cases.length, hm.slice(0, 200));
  }
  // ── Phase 8: analytics ──
  const an = await S.getAnalytics({ days: 365 });
  const sumStatus = Object.values(an.outcomes.by_status).reduce((a, b) => a + b, 0);
  const modelTotals = Object.values(an.outcomes.by_model).reduce((a, m) => a + Object.values(m).reduce((x, y) => x + y, 0), 0);
  check("analytics: the outcome counts add up to the executions, overall and summed over the models", an.outcomes.total === sumStatus && sumStatus === modelTotals && sumStatus > 100, [an.outcomes.total, sumStatus, modelTotals]);
  const chips = await S.listExecutions({ days: 365, limit: 1 });
  check("analytics: the same window in the executions list has the same number of executions (the figure and the rows it opens agree)", chips.total === an.outcomes.total, [chips.total, an.outcomes.total]);
  const gptModel = an.models.find((m) => m.startsWith("openai/"));
  if (gptModel) {
    const one = await S.getAnalytics({ days: 365, model: gptModel });
    const rows = await S.listExecutions({ days: 365, model: gptModel, limit: 1 });
    check("analytics: choosing a model narrows every figure to it, and its executions list has the same count", Object.keys(one.outcomes.by_model).join() === gptModel && rows.total === one.outcomes.total, [Object.keys(one.outcomes.by_model), rows.total, one.outcomes.total]);
  }
  const l3 = await S.listExecutions({ days: 365, failed_layer: "L3", limit: 3 });
  const l3stat = Object.values(an.layers.by_model).reduce((a, m) => a + (m.L3?.failed ?? 0), 0);
  check("analytics: the executions that failed layer L3 are the ones the layer table counts as failed, and each really failed L3", l3.total === l3stat && (l3.results.length === 0 || (await getResult(l3.results[0].result_id)).layers?.L3 === "failed"), [l3.total, l3stat]);
  const spec = Object.keys(an.routing.specialists)[0];
  if (spec) {
    const sp = await S.listExecutions({ days: 365, specialist: spec, limit: 50 });
    check("analytics: filtering by a specialist returns only executions routed to it", sp.total >= an.routing.specialists[spec].executions && sp.results.every((r) => r.specialist === spec), [sp.total, spec]);
  }
  const toolName = Object.keys(an.routing.tools)[0];
  if (toolName) {
    const tl = await S.listExecutions({ days: 365, tool: toolName, limit: 50 });
    check("analytics: filtering by a tool returns only executions that called it", tl.total === an.routing.tools[toolName].executions && tl.results.every((r) => r.tools.includes(toolName)), [tl.total, an.routing.tools[toolName].executions]);
  }
  check("analytics: P50 never exceeds P95, which never exceeds the slowest, for every model", Object.values(an.latency).every((l) => l.n === 0 || ((l.p50 ?? 0) <= (l.p95 ?? 0) && (l.p95 ?? 0) <= (l.max ?? 0))));
  check("analytics: coverage never claims more cases run than the dataset has", Object.values(an.coverage).every((c) => c.cases_total === null || c.cases_run <= c.cases_total));
  const cost = await getCostOverview().catch(() => null);
  const anHtml = html(createElement(AnalyticsBody, { a: an, cost }));
  const anText = text(anHtml);
  check("the analytics page draws all nine panels: outcomes, coverage, six layers, latency, routing, tools, reliability, drift and spend", ["outcomes", "coverage", "layers", "latency", "routing", "tools", "reliability", "drift", "spend"].every((k) => anHtml.includes(`data-testid="an-${k}"`)), anText.slice(0, 200));
  check("the layer table has a column for each of L1 to L6 and says what a grey cell means", S.LAYER_IDS.every((l) => anText.includes(l)) && anText.includes("Grey: it did not apply"));
  check("an outcome segment links to the executions of that model and status, in the same window", anHtml.includes(encodeURIComponent("idays") + "=365") && /href="[^"]*st=failed/.test(anHtml), anHtml.match(/href="[^"]*"/g)?.slice(0, 3));
  check("the drill-down address carries the window, the scripted choice and the dataset, so the rows match the figure", drill({ window_days: 30, include_synthetic: true, dataset: "d" }, { fl: "L3" }).includes("idays=30") && drill({ window_days: 30, include_synthetic: true, dataset: "d" }, { fl: "L3" }).includes("isyn=1") && drill({ window_days: 30, include_synthetic: true, dataset: "d" }, { fl: "L3" }).includes("dsf=d"));
  check("the spend panel shows the month's total with confirmed and estimated apart, and never a bare number without its basis", !cost || (anText.includes("Confirmed by a provider bill") && anText.includes("estimated from tokens")));
  check("the map has the data lake with its objects, and it feeds the datasets", !!g.nodes.find((n) => n.kind === "lake") && g.edges.some((e) => e.kind === "stores"), g.nodes.map((n) => n.kind));
  check("the Analytics view module renders without data (a loading state, no crash)", typeof AnalyticsView === "function");
  const skillsNode = g.nodes.find((n) => n.kind === "skills");
  const obsAll = await S.getObserved();
  check("skills are on the map from what the traces recorded: the same names as the observed list, linked from the agent, each with its own count", !!skillsNode && obsAll.skills.length > 0 && (skillsNode!.stats.items as string[]).join() === obsAll.skills.map((k) => k.name).join()
    && g.edges.some((e) => e.from === "agent" && e.to === "skills" && e.kind === "loads") && obsAll.skills.every((k) => k.executions > 0 && k.executions >= k.ran), skillsNode?.stats);
  // ── runs: compare, summary, gate, report ──
  const allRuns = await S.listRuns({ limit: 200 });
  const realRuns = allRuns.filter((r) => !r.synthetic && r.dataset === "individual-single-turn" && r.executions >= 40);
  check("the stored real runs are listed for choosing, complete ones only", realRuns.length >= 2 && allRuns.every((r) => r.state === "complete"), allRuns.length);
  if (realRuns.length >= 2) {
    const [newer, older] = realRuns;
    const cmp = await S.compareRuns(older.run_id, newer.run_id);
    const moved = cmp.newly_failing.length + cmp.newly_passing.length + cmp.changed.length;
    check("compare: every case is counted once (changed, unchanged, and those in only one run)", moved + cmp.unchanged === cmp.cases_compared && cmp.a.executions === older.executions && cmp.b.executions === newer.executions, [moved, cmp.unchanged, cmp.cases_compared]);
    const failed = cmp.newly_failing[0];
    if (failed) {
      const inA = await S.listExecutions({ run_id: older.run_id, case: failed.case, include_synthetic: true, limit: 50 });
      const inB = await S.listExecutions({ run_id: newer.run_id, case: failed.case, include_synthetic: true, limit: 50 });
      check("compare: a newly failing case really passed in run A and failed in run B, in the executions list", inA.results.some((r) => r.case === failed.case && r.status === "passed") && inB.results.some((r) => r.case === failed.case && r.status === "failed"), [inA.by_status, inB.by_status]);
    }
    const body = html(createElement(CompareBody, { c: cmp }));
    const bodyText = text(body);
    check("compare: the view names both runs, gives the pass-rate, cost and latency differences, and lists the changed cases with a link to each run", bodyText.includes(older.run_id) && bodyText.includes(newer.run_id) && bodyText.includes("B against A") && bodyText.includes("pass rate")
      && (cmp.newly_failing.length === 0 || (body.includes('data-testid="cmp-failing"') && body.includes("ir=" + older.run_id))), bodyText.slice(0, 300));
    check("compare: different models or versions are said to be not like for like, and the choice list shows each run's model, dataset and pass rate", (older.model === newer.model && older.version === newer.version) === !bodyText.includes("not like for like") && runLabel(older).includes(older.model ?? "no model"));
    const rep = await S.getRunReport(older.run_id);
    check("the stored report of a run is readable through the gateway", typeof rep === "string" && rep.length > 100, String(rep).slice(0, 80));
    const detail = await S.getRunDetail(older.run_id);
    const sum = html(createElement(RunSummaryBody, { run: detail, report: rep.slice(0, 40), onReport: noop }));
    const sumText = text(sum);
    check("the run summary shows the pass rate with its 95% range, the executions that gave a verdict, the repeated and flaky counts, and says so when nothing was repeated", sumText.includes(detail.run_id) && sum.includes('data-testid="run-pass-rate"') && /95% \d+%.\d+%/.test(sumText) && (detail.reliability?.repeated_cases !== 0 || sumText.includes("reliability cannot be judged")), sumText.slice(0, 300));
    check("a run with no gate says no gate was applied, instead of showing a verdict", detail.gate !== null || (sumText.includes("No quality gate was applied") && !sum.includes('data-testid="gate-verdict"')));
  }
  const listHtml = html(createElement(RunList, { runs: allRuns, onCompare: noop }));
  check("the run list shows every stored run once, with its model, dataset, pass rate and cost, each opening its executions and offering a comparison", (listHtml.match(/data-run=/g) ?? []).length === allRuns.length && allRuns.every((r) => listHtml.includes(r.run_id) && listHtml.includes("ir=" + r.run_id)) && text(listHtml).includes("Compare"), allRuns.length);
  const gated = (await S.listRuns({ limit: 200 })).filter((r) => r.synthetic);
  let gatedDetail: S.RunDetail | null = null;
  for (const r of gated) { const d = await S.getRunDetail(r.run_id); if (d.gate) { gatedDetail = d; break; } }
  if (gatedDetail) {
    const gh = html(createElement(RunSummaryBody, { run: gatedDetail }));
    check("a run that had a quality gate shows its verdict and every check with what was measured and what was required", gh.includes('data-testid="gate-verdict"') && text(gh).includes(gatedDetail.gate!.passed ? "passed" : "failed") && (gh.match(/<li/g) ?? []).length === gatedDetail.gate!.checks.length && text(gh).includes("required"), text(gh).slice(0, 250));
  } else {
    check("a run that had a quality gate shows its verdict (no stored run has one, so this was not exercised)", true);
  }
  const hl = S.headline(g);
  check("the headline sentence on the real ecosystem names how many parts are failing and the most urgent one with its reason", hl.state === "bad" ? /\d+ parts? (is|are) failing/.test(hl.text) && !!hl.nodeId && hl.text.includes(g.nodes.find((n) => n.id === hl.nodeId)!.health.reason) : hl.text.length > 10, hl);
  const hlHtml = text(html(createElement(Headline, { graph: g, onLook: noop })));
  check("the page shows that sentence with a button that takes you to the part", hlHtml.includes(hl.text.slice(0, 20)) && (hl.nodeId ? hlHtml.includes("Show me") : true), hlHtml.slice(0, 200));
  check("every kind of part on the real map has a plain-words explanation, and so has every column", g.nodes.every((n) => !!S.KIND_HELP[n.kind]) && g.layers.every((l) => !!S.LAYER_HELP[l]), [g.nodes.filter((n) => !S.KIND_HELP[n.kind]).map((n) => n.kind), g.layers.filter((l) => !S.LAYER_HELP[l])]);
  const primer = text(html(createElement(Primer, { graph: g, onClose: noop })));
  check("the explainer says what the map is, lists the real columns in order, and explains the colours, the links and how to use it", primer.includes("What you are looking at") && g.layers.every((l, i) => primer.includes(`${i + 1}. ${l}`)) && primer.includes("healthy") && primer.includes("failing") && primer.includes("moving dashes") && primer.includes("Hover") && primer.includes("Keyboard"), primer.slice(0, 300));
  const lay = S.layoutGraph(g);
  const first = lay.nodes.find((n) => n.layer === 0)!;
  const right = S.arrowTarget(lay.nodes, first.id, "ArrowRight");
  check("the arrow keys move across the map: right goes to the next column, left comes back, up and down move within a column, and an edge goes nowhere", !!right && lay.byId[right].layer > first.layer && S.arrowTarget(lay.nodes, right!, "ArrowLeft") !== null && S.arrowTarget(lay.nodes, first.id, "ArrowLeft") === null
    && S.arrowTarget(lay.nodes, first.id, "ArrowUp") === null && (lay.nodes.filter((n) => n.layer === 0).length < 2 || S.arrowTarget(lay.nodes, first.id, "ArrowDown") !== null));
  check("a refresh that finds nothing new does not redraw the map, one that does, does", S.sameGraph(g, { ...g, as_of: "later" }) && !S.sameGraph(g, { ...g, nodes: g.nodes.slice(1) }) && S.sameGraph(null, null) && !S.sameGraph(null, g));
  check("with nothing recorded the headline says so, and when all is well it says that", S.headline({ nodes: [] }).text.includes("Nothing is recorded") && S.headline({ nodes: [{ ...g.nodes[0], health: { state: "ok", reason: "fine" } }] }).state === "ok");
  check("the header pill names the real state of the ecosystem", ["failing", "to watch", "healthy"].some((w) => text(html(createElement(StatePill, { graph: g }))).includes(w)));
}

function byIdOf(g: S.StudioGraph, id: string) { return g.nodes.find((n) => n.id === id); }

async function main(): Promise<number> {
  if (process.env.STUDIO_SUITE === "reads") await reads(); else await writes();
  console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
  return failures === 0 ? 0 : 1;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(2); });
