// Single sign-on from the portal. The portal keeps its own copy of the token in localStorage for its own pages; for
// the Automation Chat app (a separate app on another port) it also puts the token in an httpOnly cookie that the
// browser sends to every port of this host (and every subdomain when SSO_COOKIE_DOMAIN is set).
export const AUTOMATION_URL = (process.env.NEXT_PUBLIC_AUTOMATION_URL || "http://localhost:3004").replace(/\/+$/, "");

/** Where a post-login `?next=` may send the user: this app, or the Automation Chat app. Anything else is ignored. */
export function safeNext(next: string | null | undefined): string | null {
  if (!next || typeof window === "undefined") return null;
  try {
    const target = new URL(next, window.location.origin);
    const allowed = [window.location.origin, new URL(AUTOMATION_URL).origin];
    return allowed.includes(target.origin) ? target.toString() : null;
  } catch {
    return null;
  }
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

/** Publish the signed-in token for the Automation Chat app. Safe to call repeatedly. */
export async function startSso(token: string): Promise<boolean> {
  try {
    const res = await fetch("/api/sso/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ token }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Sign out of the shared session (the Automation Chat app signs out with it). */
export function endSso(): Promise<unknown> {
  return fetch("/api/sso/session", { method: "DELETE", credentials: "same-origin", keepalive: true }).catch(() => undefined);
}
