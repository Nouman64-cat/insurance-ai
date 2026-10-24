// The Evaluation Center's own navigation, in one place: the layout draws its tabs from this list, the old routes redirect through it, and the
// navigation regression test reads it. Nothing here calls the backend.

export interface CenterTab { id: string; href: string; label: string; match: (path: string) => boolean }

export const CENTER_ROOT = "/super-admin/evaluation";
export const TEMPLATES_ROUTE = "/super-admin/templates";           // shared operational configuration: it keeps its own route and is linked from here

export const CENTER_TABS: CenterTab[] = [
  { id: "overview", href: CENTER_ROOT, label: "Overview", match: (p) => p === CENTER_ROOT },
  { id: "datasets", href: `${CENTER_ROOT}/datasets`, label: "Datasets & Evaluation Templates", match: (p) => p.startsWith(`${CENTER_ROOT}/datasets`) },
  { id: "drift", href: `${CENTER_ROOT}/drift`, label: "Drift & Change Review", match: (p) => p.startsWith(`${CENTER_ROOT}/drift`) },
  { id: "benchmarking", href: `${CENTER_ROOT}/benchmarking`, label: "Model Benchmarking", match: (p) => p.startsWith(`${CENTER_ROOT}/benchmarking`) },
];

/** Where each page that used to be its own sidebar entry lives now. The old address keeps working: it redirects, with its query string. */
export const MOVED_ROUTES: Record<string, string> = {
  "/super-admin/datasets": `${CENTER_ROOT}/datasets`,
  "/super-admin/drift-monitor": `${CENTER_ROOT}/drift`,
  "/super-admin/llm-benchmarking": `${CENTER_ROOT}/benchmarking`,
};

export function crumbsFor(path: string): { label: string; href?: string }[] {
  const tab = CENTER_TABS.find((t) => t.id !== "overview" && t.match(path));
  const root = { label: "AI Evaluation Center", href: tab ? CENTER_ROOT : undefined };
  return tab ? [root, { label: tab.label }] : [root];
}
