// Where the manual dashboard (the portal) lives. The copilot runs on its own origin, but everything it opens or
// embeds (case views, forms, record pages) is a portal page, so those URLs and the postMessage target origin come
// from here instead of window.location.
export const PORTAL_URL = (process.env.NEXT_PUBLIC_PORTAL_URL || "http://localhost:3000").replace(/\/+$/, "");
export const PORTAL_ORIGIN = new URL(PORTAL_URL).origin;

/** Absolute portal URL for a path such as "/case/123". */
export const portalUrl = (path: string) => `${PORTAL_URL}${path.startsWith("/") ? path : `/${path}`}`;
