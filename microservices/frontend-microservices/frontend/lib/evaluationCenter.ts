// The Evaluation Studio's old addresses. Each page that used to be a sidebar entry or a tab of the Evaluation Center still has a working link: it is redirected (a real HTTP redirect, query string
// kept) into the Studio, to the mode or the workbench tool that now holds it. next.config.mjs carries the same table; the navigation test checks the two agree.
export const CENTER_ROOT = "/super-admin/evaluation";
export const TEMPLATES_ROUTE = "/super-admin/templates";           // shared operational configuration: it keeps its own route and is linked from the Studio

export const MOVED_ROUTES: Record<string, string> = {
  "/super-admin/datasets": `${CENTER_ROOT}?tool=datasets`,
  "/super-admin/drift-monitor": `${CENTER_ROOT}?tool=drift`,
  "/super-admin/llm-benchmarking": `${CENTER_ROOT}?mode=simulate`,
  [`${CENTER_ROOT}/datasets`]: `${CENTER_ROOT}?tool=datasets`,
  [`${CENTER_ROOT}/drift`]: `${CENTER_ROOT}?tool=drift`,
  [`${CENTER_ROOT}/benchmarking`]: `${CENTER_ROOT}?mode=simulate`,
  [`${CENTER_ROOT}/costs`]: `${CENTER_ROOT}?tool=costs`,
};
