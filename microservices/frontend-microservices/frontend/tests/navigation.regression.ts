// Navigation regression test for the AI Evaluation Center. It checks that the consolidation lost nothing: every old address still lands on its
// feature, every feature is still mounted, the sidebar has no redundant entries, and the pages keep their state in the address (deep links, back/forward).
//   python evals/frontend/run_navigation_regression.py      (runs inside the frontend container against its own dev server)
import * as fs from "fs";
import * as path from "path";
import { CENTER_ROOT, CENTER_TABS, MOVED_ROUTES, TEMPLATES_ROUTE, crumbsFor } from "@/lib/evaluationCenter";

const ROOT = process.cwd();
const BASE = process.env.NAV_BASE || "http://localhost:3000";
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== undefined ? `\n       ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}` : ""}`);
}
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));
const pageFile = (route: string) => `app${route}/page.tsx`;

async function main(): Promise<number> {
  // 1. the tabs
  check("the Center has the four tabs the design asks for, in order", CENTER_TABS.map((t) => t.id).join() === "overview,datasets,drift,benchmarking", CENTER_TABS.map((t) => t.id));
  check("every tab has a page", CENTER_TABS.every((t) => exists(pageFile(t.href))), CENTER_TABS.filter((t) => !exists(pageFile(t.href))).map((t) => t.href));
  check("each tab is active for its own routes and no other", CENTER_TABS.every((t) => CENTER_TABS.filter((o) => o.match(t.href + (t.id === "overview" ? "" : "/x"))).map((o) => o.id).join() === t.id));
  check("breadcrumbs: the root alone on the overview, root then tab below it", crumbsFor(CENTER_ROOT).length === 1 && crumbsFor(`${CENTER_ROOT}/drift`).map((c) => c.label).join() === "AI Evaluation Center,Drift & Change Review");

  // 2. the old addresses
  for (const [from, to] of Object.entries(MOVED_ROUTES)) {
    check(`${from} is redirected in next.config`, read("next.config.mjs").includes(`source: "${from}"`) && read("next.config.mjs").includes(`destination: "${to}"`));
    check(`${from} leads to a real page (${to})`, exists(pageFile(to)));
    const r = await fetch(`${BASE}${from}?dataset=a&q=b`, { redirect: "manual" });
    const loc = r.headers.get("location") ?? "";
    check(`${from} redirects (HTTP ${r.status}) to ${to} and keeps the query string`, [307, 308].includes(r.status) && loc.endsWith(`${to}?dataset=a&q=b`), [r.status, loc]);
  }
  for (const t of CENTER_TABS) {
    const r = await fetch(`${BASE}${t.href}`, { redirect: "manual" });
    check(`${t.href} is served`, r.status === 200, r.status);
  }
  const tpl = await fetch(`${BASE}${TEMPLATES_ROUTE}`, { redirect: "manual" });
  check("Templates keeps its own route (shared operational configuration)", tpl.status === 200 && exists(pageFile(TEMPLATES_ROUTE)), tpl.status);

  // 3. the sidebar
  const sidebar = read("components/Sidebar.tsx");
  const hrefs = Array.from(sidebar.matchAll(/href: "(\/super-admin\/[a-z-]+)"/g)).map((m) => m[1]);
  check("the sidebar offers the Center and Templates", hrefs.includes(CENTER_ROOT) && hrefs.includes(TEMPLATES_ROUTE), hrefs);
  check("the sidebar no longer lists the pages that became tabs", Object.keys(MOVED_ROUTES).every((r) => !hrefs.includes(r)), hrefs);
  check("the Center stays highlighted on its nested routes", sidebar.includes('prefix: "/super-admin/evaluation/"'));
  check("the Center's entry is limited to Super Admins", /href: "\/super-admin\/evaluation"[\s\S]{0,900}?superAdminOnly: true/.test(sidebar));

  // 4. nothing was lost: every feature component is still mounted by its route, and still has its parts
  const mounts: [string, string][] = [[`${CENTER_ROOT}/datasets`, "DatasetsWorkspace"], [`${CENTER_ROOT}/drift`, "DriftWorkspace"], [`${CENTER_ROOT}/benchmarking`, "BenchmarkingWorkspace"]];
  for (const [route, comp] of mounts) check(`${route} mounts ${comp}`, read(pageFile(route)).includes(`components/evaluation/${comp}`));
  const ds = read("components/evaluation/DatasetsWorkspace.tsx");
  check("datasets: create, upload, add case, case drawer, versions, fixtures, approve and publish are all still there", ["NewDatasetModal", "UploadCasesModal", "AddCaseModal", "CaseDrawer", "VersionsTab", "FixturesTab", "PublishModal", "/approve"].every((k) => ds.includes(k)));
  const dr = read("components/evaluation/DriftWorkspace.tsx");
  check("drift: queue, decisions, watched items, scans, knowledge base are all still there", ["Queue", "Decision", "Watched", "Scans", "Knowledge", "scan-now", "kb-sync"].every((k) => dr.includes(k)));
  const bm = read("components/evaluation/BenchmarkingWorkspace.tsx");
  check("benchmarking: setup with cost preview, live run, results and comparison, jobs are all still there", ["SetupPanel", "LiveRun", "Results", "JobsTab", "cancelJob", "rerunJob"].every((k) => bm.includes(k)));
  check("templates: the editor and history are untouched", read(pageFile(TEMPLATES_ROUTE)).includes("TemplateEditor") && read(pageFile(TEMPLATES_ROUTE)).includes("History"));

  // 5. state in the address: deep links, back and forward, persistent filters
  const urlState: [string, string[]][] = [["components/evaluation/DatasetsWorkspace.tsx", ['useQueryState("dataset")', 'useQueryState("tab"']], ["components/evaluation/DriftWorkspace.tsx", ['useQueryState("state"', 'useQueryState("kind"', 'useQueryState("severity"', 'useQueryState("q"', 'useQueryState("item")', 'useQueryState("view"']],
    ["components/evaluation/BenchmarkingWorkspace.tsx", ['useQueryState("view"', 'useQueryState("benchmark")']], [pageFile(TEMPLATES_ROUTE), ['useQueryState("key")', 'useQueryState("view"']]];
  for (const [file, keys] of urlState) check(`${path.basename(path.dirname(file)) === "templates" ? "templates" : path.basename(file, ".tsx")} keeps ${keys.length} piece(s) of state in the address`, keys.every((k) => read(file).includes(k)), keys.filter((k) => !read(file).includes(k)));
  check("typing in a filter does not fill the browser history (replace), choosing a tab does (push)", read("components/evaluation/DriftWorkspace.tsx").includes('useQueryState("q", "", { replace: true })') && read("lib/useQueryState.ts").includes("router.push"));

  // 6. contextual links between the parts
  check("a review item links to its dataset, its template and benchmarking", ["/super-admin/evaluation/datasets?dataset=", "/super-admin/templates?key=", "/super-admin/evaluation/benchmarking"].every((k) => dr.includes(k)));
  check("the templates page links to the review items, the knowledge base and the datasets", ["/super-admin/evaluation/drift?q=", "/super-admin/evaluation/drift?view=knowledge", "/super-admin/evaluation/datasets"].every((k) => read(pageFile(TEMPLATES_ROUTE)).includes(k)));
  check("the datasets tab shows the form templates under test with a link to manage them", read(pageFile(`${CENTER_ROOT}/datasets`)).includes("templates-strip") && read(pageFile(`${CENTER_ROOT}/datasets`)).includes("TEMPLATES_ROUTE"));
  check("the overview draws only from the existing APIs (no figures typed into the page)", ["listDatasets", "getOverview", "listBenchmarks", "listJobs", "listTemplates"].every((k) => read(pageFile(CENTER_ROOT)).includes(k)) && !/\b(?:open-count[^\n]*>\s*\d)/.test(read(pageFile(CENTER_ROOT))));
  console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
  return failures === 0 ? 0 : 1;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(2); });
