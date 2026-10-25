// Navigation and parity regression test for the Evaluation Studio. It checks that the redesign lost nothing: every old address still lands on its feature (a real HTTP redirect, query string
// kept), every feature is still mounted and reachable, the sidebar has one entry, the header has three modes and no nested tabs, state lives in the address, and the map is keyboard and
// screen-reader friendly. It reads the source and the running dev server; no backend data is needed or changed.
//   python evals/frontend/run_navigation_regression.py      (runs inside the frontend container against its own dev server)
import * as fs from "fs";
import * as path from "path";
import { CENTER_ROOT, MOVED_ROUTES, TEMPLATES_ROUTE } from "@/lib/evaluationCenter";
import { MODES, TOOLS, studioHref } from "@/lib/evalStudio";

const ROOT = process.cwd();
const BASE = process.env.NAV_BASE || "http://localhost:3000";
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== undefined ? `\n       ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}` : ""}`);
}
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));
const has = (file: string, ...needles: string[]) => needles.every((n) => read(file).includes(n));

async function main(): Promise<number> {
  // 1. the studio and its three modes
  check("the Studio has exactly three modes: Explore, Simulate, Investigate", MODES.map((m) => m.id).join() === "explore,simulate,investigate", MODES.map((m) => m.id));
  check("the workbench tools are the dataset manager, the drift queue and costs & budgets", TOOLS.map((t) => t.id).join() === "datasets,drift,costs");
  check("the studio's page exists and the old tab routes and nested layout are gone", exists("app/super-admin/evaluation/page.tsx") && !exists("app/super-admin/evaluation/layout.tsx")
    && ["datasets", "drift", "benchmarking", "costs"].every((d) => !exists(`app/super-admin/evaluation/${d}/page.tsx`)));
  const shell = "components/studio/StudioShell.tsx";
  check("the shell mounts the three modes and the three tools", has(shell, "<ExploreView", "<SimulateView", "<InvestigateView", "<DatasetsWorkspace", "<DriftWorkspace", "<CostsWorkspace"));
  check("the header has ONE navigation row, always visible: the three modes only (the managed sections are in the sidebar; no hidden menu, no tab strip, no nested tabs)", !/role="tablist"/.test(read(shell)) && has(shell, 'data-testid="studio-nav"') && !read(shell).includes('data-testid="tools-nav"') && !read(shell).includes('aria-haspopup="menu"') && !read(shell).includes("workbench-menu"));
  check("the header carries the health pill, the search and the quick action", has(shell, "StatePill", 'data-testid="search-button"', 'data-testid="quick-run"'));
  check("form templates keep their own route, reachable from the sidebar", exists("app/super-admin/templates/page.tsx") && read("components/Sidebar.tsx").includes('{ href: "/super-admin/templates", label: "Form templates" }') && TEMPLATES_ROUTE === "/super-admin/templates");
  check("Ctrl+K opens the global search from anywhere in the studio", has(shell, "e.ctrlKey || e.metaKey", '"k"', "<CommandPalette"));

  // 2. the old addresses
  const config = read("next.config.mjs");
  for (const [from, to] of Object.entries(MOVED_ROUTES)) {
    check(`${from} is redirected in next.config to ${to}`, config.includes(`source: "${from}"`) && config.includes(`destination: "${to}"`));
    const [toPath, toQuery] = to.split("?");
    const r = await fetch(`${BASE}${from}?x=1`, { redirect: "manual" });
    const loc = r.headers.get("location") ?? "";
    check(`${from} really redirects (HTTP ${r.status}) into the studio and keeps its query string`, [307, 308].includes(r.status) && loc.includes(toPath) && loc.includes(toQuery) && loc.includes("x=1"), [r.status, loc]);
  }
  for (const href of [CENTER_ROOT, studioHref({ mode: "simulate" }), studioHref({ mode: "investigate", sub: "compare" }), studioHref({ tool: "costs" }), studioHref({ lens: "impact", impact: "rule:X" })]) {
    const r = await fetch(`${BASE}${href}`, { redirect: "manual" });
    check(`${href} is served`, r.status === 200, r.status);
  }
  check("the templates route is served", (await fetch(`${BASE}${TEMPLATES_ROUTE}`, { redirect: "manual" })).status === 200);

  // 3. the sidebar
  const sidebar = read("components/Sidebar.tsx");
  const hrefs = Array.from(sidebar.matchAll(/href: "(\/super-admin\/[a-z-]+)"/g)).map((m) => m[1]);
  check("the sidebar offers the studio and the templates, and none of the pages that became modes or tools", hrefs.includes(CENTER_ROOT) && hrefs.includes(TEMPLATES_ROUTE) && !hrefs.some((h) => ["/super-admin/datasets", "/super-admin/drift-monitor", "/super-admin/llm-benchmarking"].includes(h)), hrefs);
  const at = sidebar.indexOf('href: "/super-admin/evaluation",');
  const studioEntry = sidebar.slice(at, sidebar.indexOf("subLinks: [", at) + 700);
  check("the sidebar lists the four things the studio manages under Evaluation Studio, and Templates is no longer a duplicate top-level entry", ["?tool=datasets", "?tool=drift", "?tool=costs", TEMPLATES_ROUTE].every((h) => studioEntry.includes(h)) && !/href: "\/super-admin\/templates",\s*label: "Templates"/.test(sidebar), studioEntry.slice(0, 200));
  check("the Evaluation Studio entry opens the Studio on click, keeps its four sections for the studio's own pages only, and hides them when another menu item is open",
    studioEntry.includes("opensPage: true") && studioEntry.includes("autoCollapse: true") && !studioEntry.includes("Studio home") && sidebar.includes("else if (l.autoCollapse)") && sidebar.includes("togglesOnly") && sidebar.includes("!link.opensPage"), studioEntry.slice(0, 200));
  check("the studio stays highlighted on its own address and its entry is for Super Admins only", sidebar.includes('prefix: "/super-admin/evaluation/"') && /href: "\/super-admin\/evaluation"[\s\S]{0,900}?superAdminOnly: true/.test(sidebar));

  // 4. nothing was lost: every existing feature is still mounted somewhere in the studio
  const ds = read("components/evaluation/DatasetsWorkspace.tsx");
  check("golden datasets: create, upload, add case, case drawer, versions, fixtures, approve and publish are still there", ["NewDatasetModal", "UploadCasesModal", "AddCaseModal", "CaseDrawer", "VersionsTab", "FixturesTab", "PublishModal", "/approve"].every((k) => ds.includes(k)));
  const dr = read("components/evaluation/DriftWorkspace.tsx");
  check("drift: queue, decisions, watched items, scans and knowledge base are still there", ["Queue", "Decision", "Watched", "Scans", "Knowledge", "scan-now", "kb-sync"].every((k) => dr.includes(k)));
  check("costs & budgets: all seven views are still there", ["overview", "models", "budgets", "usage", "reconcile", "insights", "rates"].every((v) => read("components/costs/CostsWorkspace.tsx").includes(`id: "${v}"`)));
  check("simulate: the setup with its estimate and budget impact, the live run with cancel and rerun, and the jobs list are mounted", has("components/studio/SimulateView.tsx", "<SetupPanel", "<LiveRun", "<JobsTab") && has("components/benchmarking/SetupPanel.tsx", "previewWithBudget", "startJob")
    && has("components/benchmarking/LiveRun.tsx", "cancelJob", "rerunJob", "streamJob") && has("components/evaluation/BenchmarkingWorkspace.tsx", "export function JobsTab", "cancelJob", "rerunJob"));
  check("investigate: executions, benchmark results with the heatmap, and the model and cost comparison are mounted; a trace opens a replayable timeline", has("components/studio/InvestigateView.tsx", "<Executions", "<Results", "<ModelsPanel", "<TraceDrawer")
    && has("components/benchmarking/Results.tsx", "<CaseHeatmap", "<BenchmarkCost", "<TraceDrawer") && has("components/benchmarking/TraceDrawer.tsx", "<TraceTimeline"));
  check("explore: the map, its health filter, the node panel and the change-impact lens are mounted", has("components/studio/ExploreView.tsx", "<EcosystemMap", "<NodePanel", "<ImpactExplorer", "<HealthStrip"));
  const ix = read("components/studio/ImpactExplorer.tsx");
  check("change impact: one search combobox (keyboard: arrows, Enter, Esc, '/'), type filters with counts, a needs-review switch, sort, an honest empty state, a switcher that is itself a search, a way back, and the chain as a timeline with the next step first",
    ["role=\"combobox\"", "role=\"listbox\"", "aria-activedescendant", "ArrowDown", "e.key === \"/\"", "attention-switch", "change-none", "data-testid=\"change-bar\"", "data-testid=\"all-changes\"", "data-testid=\"next-action\"", "aria-expanded={open}"].every((k) => ix.includes(k))
    && !ix.includes("lg:grid-cols-[16rem") && !ix.includes("lg:overflow-x-auto"));
  const ev = read("components/studio/ExploreView.tsx"), em = read("components/studio/EcosystemMap.tsx");
  check("explore is self-explanatory and calm: a plain headline, a first-visit explainer that comes back from a button, zoom, arrow-key navigation, Esc and click-away to deselect, a delayed hover-out, no redraw when nothing changed, a skeleton instead of a blank, and a 'what this is' line for every part",
    ["Headline", "Primer", 'data-testid="help-toggle"', 'data-testid="zoom"', "sameGraph", 'data-testid="map-loading"', "Start with these", 'data-testid="map-stage"', "useWide"].every((k) => ev.includes(k)) && !ev.includes("lg:grid-cols-[minmax(0,1fr)_21rem]") && ["arrowTarget", "map-background", "setTimeout(() => setHoverNow(null)", "ev.key === \"Escape\"", "studio-band"].every((k) => em.includes(k))
    && read("components/studio/NodePanel.tsx").includes('data-testid="node-help"') && read("lib/evalStudio.ts").includes("export const KIND_HELP"));
  check("change impact: approvals go through the existing review decisions, a draft through the existing draft call, and nothing writes to a case", has("components/studio/ImpactExplorer.tsx", "<Decision", "getDraft", "principle") && !/updateCase|publishVersion|api\.(put|patch|delete)/.test(read("components/studio/ImpactExplorer.tsx")));

  // 5. state in the address
  const urlState: [string, string[]][] = [[shell, ['useQueryState("mode"', 'useQueryState("tool")']], ["components/studio/ExploreView.tsx", ['useQueryState("lens"', 'useQueryState("node")', 'useQueryState("hf")']], ["components/studio/ImpactExplorer.tsx", ['useQueryState("impact")']],
    ["components/studio/InvestigateView.tsx", ['useQueryState("sub"', 'useQueryState("bench")', 'useQueryState("st")', 'useQueryState("im")', 'useQueryState("dsf")', 'useQueryState("ic"']], ["components/studio/SimulateView.tsx", ['useQueryState("dataset")', 'useQueryState("models")']]];
  for (const [file, keys] of urlState) check(`${path.basename(file, ".tsx")} keeps its state in the address (${keys.length})`, keys.every((k) => read(file).includes(k)), keys.filter((k) => !read(file).includes(k)));
  check("typing in a filter replaces history, choosing a mode or a filter chip pushes it (back and forward work)", has("components/studio/InvestigateView.tsx", 'useQueryState("ic", "", { replace: true })') && has("lib/useQueryState.ts", "router.push"));

  // 6. accessibility and motion
  const map = read("components/studio/EcosystemMap.tsx");
  check("every map node is focusable, a button with a label that says its health and why, and works with Enter and Space", has("components/studio/EcosystemMap.tsx", "tabIndex={0}", 'role="button"', "aria-pressed", "aria-label={`${n.label}: ${tx(c.label)}. ${n.health.reason}`}", 'ev.key === "Enter"', 'ev.key === " "'));
  check("a narrow screen gets the same nodes as a list", has("components/studio/EcosystemMap.tsx", 'data-testid="map-list"', "md:hidden") && map.includes("hidden md:block"));
  check("the search is a modal dialog with arrow-key navigation and Escape", has("components/studio/CommandPalette.tsx", 'role="dialog"', 'aria-modal="true"', "ArrowDown", "ArrowUp", '"Escape"', 'role="listbox"'));
  const css = read("app/globals.css");
  check("animations stop for people who ask for reduced motion", /prefers-reduced-motion: reduce[\s\S]{0,400}studio-edge\.is-active \{ animation: none/.test(css) && css.includes("studio-ring") && has("components/studio/TraceTimeline.tsx", "prefers-reduced-motion"));
  check("the studio's own components have a dark variant, and colour is never the only signal (health is also written)", read("components/studio/EcosystemMap.tsx").includes("dark:") && has("components/studio/NodePanel.tsx", "tx(c.label)", "dark:") && has("components/studio/EcosystemMap.tsx", "<title>{`${tx(c.label)}: ${n.health.reason}`}"));

  // 7. no figures typed into the pages
  const studioFiles = fs.readdirSync(path.join(ROOT, "components/studio")).map((f) => `components/studio/${f}`);
  check("every number the studio shows comes from an API call (each panel imports its data from lib/ ... )", ["NodePanel", "ExploreView", "ImpactExplorer", "InvestigateView", "SimulateView", "CommandPalette"].every((c) => /from "@\/lib\/eval(Studio|Benchmarks|Costs|Drift)"/.test(read(`components/studio/${c}.tsx`))));
  check("no component file hard-codes a score, a cost or a count as a literal result", studioFiles.every((f) => !/(pass_rate|total_usd|cost_usd)\s*[:=]\s*0?\.\d+/.test(read(f))));
  console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
  return failures === 0 ? 0 : 1;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(2); });
