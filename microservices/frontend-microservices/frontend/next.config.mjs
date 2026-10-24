// The underwriting pages moved to the Underwriting Workbench (underwriting-app/). Old portal URLs, bookmarks and
// links in emails keep working: they are redirected there with the same path and query string.
const UNDERWRITING_URL = (process.env.NEXT_PUBLIC_UNDERWRITING_URL || "http://localhost:3005").replace(/\/+$/, "");
const PORTAL_URL = (process.env.NEXT_PUBLIC_PORTAL_URL || "http://localhost:3000").replace(/\/+$/, "");
const UNDERWRITING_ROUTES = ["/underwriting", "/pre-underwriting", "/post-underwriting", "/live-evaluation", "/assessments"];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  optimizeFonts: false,
  // Dev only: keep compiled routes warm. The defaults evict a page after ~1 min
  // idle (keeping only 5), so moving around the 30+ dashboard routes kept
  // triggering full recompiles on click.
  onDemandEntries: {
    maxInactiveAge: 60 * 60 * 1000,
    pagesBufferLength: 50,
  },
  // Lets client code tell demo from prod (see lib/envMode.ts).
  env: { NEXT_PUBLIC_ENV_VAR: process.env.ENV_VAR || "" },
  async redirects() {
    // The AI Evaluation Center replaced three sidebar pages. The old addresses keep working (bookmarks, links in notices): a real HTTP redirect, query string kept.
    const evaluationCenter = [
      { source: "/super-admin/datasets", destination: "/super-admin/evaluation/datasets", permanent: false },
      { source: "/super-admin/drift-monitor", destination: "/super-admin/evaluation/drift", permanent: false },
      { source: "/super-admin/llm-benchmarking", destination: "/super-admin/evaluation/benchmarking", permanent: false },
    ];
    // Pointing the workbench at the portal itself would redirect these pages to themselves forever.
    if (new URL(UNDERWRITING_URL).origin === new URL(PORTAL_URL).origin) return evaluationCenter;
    return [
      ...evaluationCenter,
      ...UNDERWRITING_ROUTES.flatMap((route) => [
        { source: route, destination: `${UNDERWRITING_URL}${route}`, permanent: false },
        { source: `${route}/:path*`, destination: `${UNDERWRITING_URL}${route}/:path*`, permanent: false },
      ]),
      { source: "/case/:path*", destination: `${UNDERWRITING_URL}/case/:path*`, permanent: false },
    ];
  },
};

export default nextConfig;
