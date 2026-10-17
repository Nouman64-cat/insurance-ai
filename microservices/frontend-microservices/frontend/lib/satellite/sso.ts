// Single sign-on for the apps that sign in through the portal (the Underwriting Workbench, Request Management). They
// have no login of their own: the portal signs the user in and puts the token in the shared httpOnly cookie
// (SSO_COOKIE_NAME, insurance_sso); each app's /api/sso/session (lib/satellite/sessionRoute.ts) checks it with the API
// gateway and hands the verified user to the page (components/satellite/SsoGate.tsx).
//
// Each such app has a one-line lib/sso.ts re-exporting this file, which replaces the portal's lib/sso.ts there: shared
// portal code that imports "@/lib/sso" (the API client's 401 handling) gets these versions, which send the user to
// the portal's login and back.
import { portalLoginUrl, PORTAL_URL, safeRedirect } from "@/lib/appLinks";

/** localStorage keys the shared portal code reads the session from. */
export const SESSION_KEYS = ["jwt_token", "tenant_id", "tenant_name", "user_email", "user_name", "user_role", "branch_id"];

/** Where a `?next=` may send the user: this app or another configured app. */
export function safeNext(next: string | null | undefined): string | null {
  if (typeof window === "undefined") return null;
  return safeRedirect(next, window.location.origin);
}

export function clearLocalSession(): void {
  try {
    SESSION_KEYS.forEach((key) => localStorage.removeItem(key));
  } catch { /* storage unavailable */ }
}

/** Clear the shared cookie: the portal and the Automation Chat sign out with it. */
export function endSso(): Promise<unknown> {
  return fetch("/api/sso/session", { method: "DELETE", credentials: "same-origin", keepalive: true }).catch(() => undefined);
}

// Guards against a sign-in loop (portal login -> here -> portal login...) if the two apps ever disagree about the
// session, for example a cookie that the gateway rejects but the portal keeps re-publishing.
const LOGIN_REDIRECTS_KEY = "uw_login_redirects";
const LOOP_WINDOW_MS = 60_000;
const LOOP_LIMIT = 3;

/** Record a trip to the login page; false when there have been too many in the last minute. */
function mayRedirectToLogin(): boolean {
  try {
    const now = Date.now();
    const recent = (JSON.parse(sessionStorage.getItem(LOGIN_REDIRECTS_KEY) || "[]") as number[]).filter((t) => now - t < LOOP_WINDOW_MS);
    if (recent.length >= LOOP_LIMIT) return false;
    sessionStorage.setItem(LOGIN_REDIRECTS_KEY, JSON.stringify([...recent, now]));
  } catch { /* storage unavailable: no loop guard */ }
  return true;
}

/** Signed in successfully: forget earlier login trips. */
export function resetLoginRedirects(): void {
  try { sessionStorage.removeItem(LOGIN_REDIRECTS_KEY); } catch { /* ignore */ }
}

/**
 * Send the user to the portal's sign-in page, to come back to this exact page (a case opened in a new tab included).
 * Returns false instead of redirecting when that has already happened several times in a row.
 */
export function redirectToLogin(): boolean {
  if (!mayRedirectToLogin()) return false;
  window.location.replace(portalLoginUrl(window.location.href));
  return true;
}

/** The API answered 401 (token expired or revoked): end the session everywhere and sign in again. */
export function sessionExpired(): void {
  clearLocalSession();
  endSso().finally(() => redirectToLogin());
}

/**
 * Sign out on purpose. Clears this app and the shared cookie, then lets the portal clear its own stored session
 * (?signout=1), so neither app signs the user straight back in.
 */
export function signOut(): void {
  clearLocalSession();
  resetLoginRedirects();
  endSso().finally(() => window.location.replace(`${PORTAL_URL}/login?signout=1`));
}
