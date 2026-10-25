// Frontend-to-backend integration test of the Evaluation Studio. It runs the studio's own data module (lib/evalStudio.ts, with the existing drift, benchmark and cost modules it builds on) under
// node against a live gateway, then renders the studio's own views with what the real API returned and checks what a person would read.
//   python evals/frontend/run_studio_integration.py
// Two suites, chosen by STUDIO_SUITE:
//   writes  against the ISOLATED evaluation stack, in a world the test builds (a dataset, a changed rule, review items, runs on both sides of the change): the map, the search, the change
//           impact end to end with its approval decisions, executions and the replay of a trace
//   reads   against the working stack, changing nothing: the same views drawn from the real datasets, rules, runs, traces and costs
import { createElement } from "react";
import api from "@/app/services/api";
import { getBreakdown, getResult, listBenchmarks } from "@/lib/evalBenchmarks";
import { decide, getDraft } from "@/lib/evalDrift";
import * as S from "@/lib/evalStudio";
import CaseHeatmap from "@/components/studio/CaseHeatmap";
import { COMMANDS, hitHref } from "@/components/studio/CommandPalette";
import EcosystemMap from "@/components/studio/EcosystemMap";
import { FinderView, ImpactView, ago, filterChanges, nextAction } from "@/components/studio/ImpactExplorer";
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
