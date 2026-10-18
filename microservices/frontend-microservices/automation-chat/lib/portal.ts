// Where the manual dashboard (the portal) and the Underwriting Workbench live. The copilot runs on its own origin, but
// everything it opens or embeds (case views, forms, record pages) is a page of one of those two apps, so those URLs
// and the postMessage target origins come from here instead of window.location.
export const PORTAL_URL = (process.env.NEXT_PUBLIC_PORTAL_URL || "http://localhost:3000").replace(/\/+$/, "");
export const PORTAL_ORIGIN = new URL(PORTAL_URL).origin;
export const UNDERWRITING_URL = (process.env.NEXT_PUBLIC_UNDERWRITING_URL || "http://localhost:3005").replace(/\/+$/, "");
export const UNDERWRITING_ORIGIN = new URL(UNDERWRITING_URL).origin;

export const CLAIMS_URL = (process.env.NEXT_PUBLIC_CLAIMS_URL || "http://localhost:3011").replace(/\/+$/, "");

export const CUSTOMER_SERVICE_URL = (process.env.NEXT_PUBLIC_CUSTOMER_SERVICE_URL || "http://localhost:3008").replace(/\/+$/, "");

/** Where a role's own dashboard is: the same destinations the portal's login page sends each role to
 *  (frontend/app/login/page.tsx), so "Back to Dashboard" from the copilot lands where that person works. */
export function homeUrlFor(role: string | null | undefined): string {
  const r = (role || "").trim();
  const compact = r.replace(/\s+/g, "");
  if (["MedicalUnderwriter", "FinancialUnderwriter", "Underwriter"].includes(compact)) return `${UNDERWRITING_URL}/underwriting`;
  if (compact === "Finance") return `${PORTAL_URL}/finance`;
  if (compact === "ClaimsManager") return `${CLAIMS_URL}/claims/dashboard`;
  if (compact === "CustomerService") return `${CUSTOMER_SERVICE_URL}/customer-service`;
  if (compact === "SuperAdmin") return portalUrl("/super-admin/tenants");
  if (r === "Agent" || r === "Broker") return portalUrl("/proposal");
  if (compact === "ClaimsAdjuster") return portalUrl("/claims");
  if (r === "Admin" || !r) return portalUrl("/");
  return portalUrl("/cases");
}

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

/** Where a link in a chat reply really points. The assistant writes app-relative links ("case/<id>",
 *  "admin/users?userId=…"), which a browser would resolve against this copilot's own origin, where those pages don't
 *  exist (404). They belong to the portal or the Underwriting Workbench. Returns the absolute URL on the right app,
 *  or null for links that are already absolute or aren't page links (http(s), mailto:, tel:, #anchors). */
export function appLinkUrl(href: string | null | undefined): string | null {
  const raw = (href || "").trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const path = raw.startsWith("/") ? raw : `/${raw.replace(/^\.\//, "")}`;
  return pageUrl(path);
}

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
