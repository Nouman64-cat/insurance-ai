// Where each front-end app lives, and which app owns a page. The underwriting pages (queue, case workspace,
// post-underwriting, live evaluation, assessments) run as the Underwriting Workbench; "/requests…" is Request
// Management; everything else is the portal. All three use this module, so a link to "/case/123" from the portal goes
// to the workbench, "/requests/new" goes to Request Management, and "/policy-issuance" from either goes to the portal.
// No imports: it is also loaded by the node tests.
//
// The URLs are build-time settings (NEXT_PUBLIC_*), written out literally so Next.js can inline them.

const trimSlash = (url: string) => url.replace(/\/+$/, "");

export const PORTAL_URL = trimSlash(process.env.NEXT_PUBLIC_PORTAL_URL || "http://localhost:3000");
export const UNDERWRITING_URL = trimSlash(process.env.NEXT_PUBLIC_UNDERWRITING_URL || "http://localhost:3005");
export const AUTOMATION_URL = trimSlash(process.env.NEXT_PUBLIC_AUTOMATION_URL || "http://localhost:3004");
export const REQUESTS_URL = trimSlash(process.env.NEXT_PUBLIC_REQUESTS_URL || "http://localhost:3007");

export const CUSTOMER_SERVICE_URL = trimSlash(process.env.NEXT_PUBLIC_CUSTOMER_SERVICE_URL || "http://localhost:3008");
export type AppName = "portal" | "underwriting" | "requests" | "customer-service";

/** The app this code is running in. Each satellite app sets NEXT_PUBLIC_APP_NAME in its next.config. */
export const CURRENT_APP: AppName =
  process.env.NEXT_PUBLIC_APP_NAME === "underwriting" ? "underwriting"
    : process.env.NEXT_PUBLIC_APP_NAME === "requests" ? "requests"
      : process.env.NEXT_PUBLIC_APP_NAME === "customer-service" ? "customer-service" : "portal";

/** Pages served by Request Management. */
export const REQUEST_ROUTES = ["/requests"] as const;

/** First path segments served by the Underwriting Workbench. "/case" is the case workspace (/case/<id>). */
export const UNDERWRITING_ROUTES = [
  "/underwriting",
  "/pre-underwriting",
  "/post-underwriting",
  "/live-evaluation",
  "/assessments",
  "/case",
] as const;

function pathOf(href: string): string {
  const path = href.split(/[?#]/)[0] || "/";
  return path.startsWith("/") ? path : `/${path}`;
}

/** Whether a path ("/case/123?autoRun=true", "underwriting") is a workbench page. "/cases" is not. */
export function isUnderwritingPath(href: string): boolean {
  const path = pathOf(href);
  return UNDERWRITING_ROUTES.some((route) => path === route || path.startsWith(`${route}/`));
}

export function isRequestsPath(href: string): boolean {
  const path = pathOf(href);
  return REQUEST_ROUTES.some((route) => path === route || path.startsWith(`${route}/`));
}

/** The app that serves a path. */
export function appFor(href: string): AppName {
  if (isUnderwritingPath(href)) return "underwriting";
  if (pathOf(href) === "/customer-service" || pathOf(href).startsWith("/customer-service/")) return "customer-service";
  if (isRequestsPath(href)) return "requests";
  return "portal";
}

const APP_URLS: Record<AppName, string> = { portal: PORTAL_URL, underwriting: UNDERWRITING_URL, requests: REQUESTS_URL, "customer-service": CUSTOMER_SERVICE_URL };

function withSlash(href: string): string {
  return href.startsWith("/") ? href : `/${href}`;
}

/** Absolute URL of a path on whichever app serves it. */
export function appUrl(href: string): string {
  return `${APP_URLS[appFor(href)]}${withSlash(href)}`;
}

/**
 * The href to put in a link or router.push: the plain path when this app serves it (client-side navigation), the
 * other app's absolute URL otherwise (a normal page load, which next/link and the router do for other origins).
 */
export function appHref(href: string): string {
  return appFor(href) === CURRENT_APP ? withSlash(href) : appUrl(href);
}

/** Absolute portal URL, e.g. for public pages the portal serves to customers (/e-application/<token>). */
export function portalUrl(path: string): string {
  return `${PORTAL_URL}${withSlash(path)}`;
}

/** Absolute workbench URL. */
export function underwritingUrl(path: string): string {
  return `${UNDERWRITING_URL}${withSlash(path)}`;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Origins a sign-in may send the user back to: the configured apps. */
export function trustedOrigins(): string[] {
  return [PORTAL_URL, UNDERWRITING_URL, AUTOMATION_URL, REQUESTS_URL, CUSTOMER_SERVICE_URL].map(originOf).filter((o): o is string => !!o);
}

/**
 * A post-login destination (`?next=`) made safe: an absolute or relative URL whose origin is the current page's or
 * one of the trusted apps', over http(s). Anything else (another site, javascript:, malformed) gives null.
 */
export function safeRedirect(next: string | null | undefined, currentOrigin: string): string | null {
  if (!next) return null;
  try {
    const target = new URL(next, currentOrigin);
    if (target.protocol !== "http:" && target.protocol !== "https:") return null;
    const allowed = new Set([currentOrigin, ...trustedOrigins()]);
    return allowed.has(target.origin) ? target.toString() : null;
  } catch {
    return null;
  }
}

/** The portal's sign-in page, returning to `next` (an absolute URL) afterwards. */
export function portalLoginUrl(next?: string): string {
  return next ? `${PORTAL_URL}/login?next=${encodeURIComponent(next)}` : `${PORTAL_URL}/login`;
}
