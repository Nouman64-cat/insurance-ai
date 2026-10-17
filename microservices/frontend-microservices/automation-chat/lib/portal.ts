// Where the manual dashboard (the portal) and the Underwriting Workbench live. The copilot runs on its own origin, but
// everything it opens or embeds (case views, forms, record pages) is a page of one of those two apps, so those URLs
// and the postMessage target origins come from here instead of window.location.
export const PORTAL_URL = (process.env.NEXT_PUBLIC_PORTAL_URL || "http://localhost:3000").replace(/\/+$/, "");
export const PORTAL_ORIGIN = new URL(PORTAL_URL).origin;
export const UNDERWRITING_URL = (process.env.NEXT_PUBLIC_UNDERWRITING_URL || "http://localhost:3005").replace(/\/+$/, "");
export const UNDERWRITING_ORIGIN = new URL(UNDERWRITING_URL).origin;

/** Absolute portal URL for a path such as "/admin/leads". */
export const portalUrl = (path: string) => `${PORTAL_URL}${path.startsWith("/") ? path : `/${path}`}`;

// Pages served by the Underwriting Workbench (the same list as the portal's lib/appLinks.ts). "/cases" is the
// portal's; "/case/<id>" is the workbench's case view.
const UNDERWRITING_ROUTES = ["/underwriting", "/pre-underwriting", "/post-underwriting", "/live-evaluation", "/assessments", "/case"];

export function isUnderwritingPath(href: string): boolean {
  const raw = href.split(/[?#]/)[0] || "/";
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return UNDERWRITING_ROUTES.some((route) => path === route || path.startsWith(`${route}/`));
}

/** Origin of the app that serves a page path. */
export const pageOrigin = (path: string) => (isUnderwritingPath(path) ? UNDERWRITING_ORIGIN : PORTAL_ORIGIN);

/** Absolute URL of a page on whichever app serves it. */
export const pageUrl = (path: string) =>
  isUnderwritingPath(path) ? `${UNDERWRITING_URL}${path.startsWith("/") ? path : `/${path}`}` : portalUrl(path);

/** Origins whose embedded pages may message the chat (and be messaged by it). */
export const EMBED_ORIGINS: ReadonlySet<string> = new Set([PORTAL_ORIGIN, UNDERWRITING_ORIGIN]);

/** Origin of an absolute URL, or null. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
