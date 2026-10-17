// Single sign-on from the portal. The portal keeps its own copy of the token in localStorage for its own pages; for
// the Automation Chat and the Underwriting Workbench (separate apps on other ports or subdomains) it also puts the
// token in an httpOnly cookie that the browser sends to every port of this host (and every subdomain when
// SSO_COOKIE_DOMAIN is set).
//
// The Underwriting Workbench has its own lib/sso.ts with the same exports that shared code uses (endSso,
// sessionExpired): shared modules import "@/lib/sso" and get the version for the app they run in.
import { AUTOMATION_URL, safeRedirect } from "@/lib/appLinks";

export { AUTOMATION_URL };

/** Where a post-login `?next=` may send the user: this app or another configured app. Anything else is ignored. */
export function safeNext(next: string | null | undefined): string | null {
  if (typeof window === "undefined") return null;
  return safeRedirect(next, window.location.origin);
}

/**
 * Open the Automation Chat in a NEW tab, but only if its container is actually running. The tab is opened right
 * away (browsers block a popup opened after an await), then pointed at the app once it answers; if nothing is
 * listening on its port the tab is closed again and `false` is returned so the caller can say how to start it.
 */
export async function openAutomationChat(): Promise<boolean> {
  const tab = window.open("about:blank", "_blank");
  try {
    // no-cors: we only need to know whether something answers on that port, not to read the reply
    await fetch(AUTOMATION_URL, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(4000) });
  } catch {
    tab?.close();
    return false;
  }
  if (tab) tab.location.href = AUTOMATION_URL;
  else window.open(AUTOMATION_URL, "_blank");
  return true;
}

/**
 * Publish the signed-in token for the other apps. "invalid" means the gateway rejected the token (expired or
 * revoked); "unavailable" means the sign-in service could not be reached, so nothing is known about the token.
 */
export async function publishSso(token: string): Promise<"ok" | "invalid" | "unavailable"> {
  try {
    const res = await fetch("/api/sso/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ token }),
    });
    if (res.ok) return "ok";
    return res.status === 401 || res.status === 400 ? "invalid" : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Publish the signed-in token for the other apps. Safe to call repeatedly. */
export async function startSso(token: string): Promise<boolean> {
  return (await publishSso(token)) === "ok";
}

/** Sign out of the shared session (the Automation Chat and the workbench sign out with it). */
export function endSso(): Promise<unknown> {
  return fetch("/api/sso/session", { method: "DELETE", credentials: "same-origin", keepalive: true }).catch(() => undefined);
}

/** The API answered 401: forget this tab's session and go to the sign-in page. */
export function sessionExpired(): void {
  try {
    localStorage.removeItem("jwt_token");
    localStorage.removeItem("tenant_id");
    localStorage.removeItem("user_email");
  } catch { /* storage unavailable */ }
  endSso();
  window.location.href = "/login";
}
