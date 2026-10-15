"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import api from "@/app/services/api";
import { clearLocalSession, redirectToLogin, resetLoginRedirects } from "@/lib/sso";
import { PORTAL_URL } from "@/lib/appLinks";
import { tx } from "@/lib/i18n/tx";

// Signs an app that has no login of its own (the Underwriting Workbench, Request Management) in from the portal's session. Nothing is rendered until the shared cookie's token has been
// verified by the API gateway (/api/sso/session -> /auth/me); the identity, tenant and role shown and used here come
// from that answer. The shared portal code reads the session from localStorage and the API client's default
// headers, so both are filled in the same way the portal's login does. The backend still authorizes every request:
// the role here only decides what the UI offers.
//
// Re-checked whenever the tab comes back into view, so signing out of (or switching user on) the portal is reflected
// here too.

export interface SatelliteUser {
  id: string;
  email: string;
  full_name: string | null;
  tenant_id: string | null;
  tenant_name: string | null;
  role_name: string;
  branch_id: string | null;
  branch_name?: string | null;
}

const SessionContext = createContext<SatelliteUser | null>(null);

/** For an app that runs without a sign-in (the Customer Service open desk): supplies the user the app is acting as. */
export function OpenSessionProvider({ user, children }: { user: SatelliteUser; children: ReactNode }) {
  return <SessionContext.Provider value={user}>{children}</SessionContext.Provider>;
}

/** The verified user. Only available below the gate. */
export function useSatelliteUser(): SatelliteUser {
  const user = useContext(SessionContext);
  if (!user) throw new Error("useSatelliteUser must be used inside <SsoGate>");
  return user;
}

function storeSession(token: string, user: SatelliteUser) {
  const set = (key: string, value: string | null | undefined) => {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  };
  try {
    set("jwt_token", token);
    set("tenant_id", user.tenant_id);
    set("tenant_name", user.tenant_name);
    set("user_email", user.email);
    set("user_name", user.full_name);
    set("user_role", user.role_name);
    set("branch_id", user.branch_id);
  } catch { /* storage unavailable: the headers below still work for this page */ }
  api.defaults.headers.common["Authorization"] = `Bearer ${token}`;
  if (user.tenant_id) api.defaults.headers.common["X-Tenant-Id"] = user.tenant_id;
  else delete api.defaults.headers.common["X-Tenant-Id"];
}

function forgetSession() {
  clearLocalSession();
  delete api.defaults.headers.common["Authorization"];
  delete api.defaults.headers.common["X-Tenant-Id"];
}

type Problem = "unreachable" | "notResponding" | "loop";

export default function SsoGate({
  children,
  noTenant,
}: {
  children: ReactNode;
  /** What to tell an account without a tenant (SuperAdmin), which can't use tenant work. */
  noTenant?: { title: string; body: string };
}) {
  const [user, setUser] = useState<SatelliteUser | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const sync = async (initial: boolean) => {
      let res: Response;
      try {
        res = await fetch("/api/sso/session", { cache: "no-store", credentials: "same-origin" });
      } catch {
        if (initial && !cancelled) setProblem("unreachable");
        return;
      }
      if (cancelled) return;
      if (res.status === 401) {
        // Not signed in, or the session expired / was revoked (the route has already cleared the cookie).
        forgetSession();
        setUser(null);
        if (!redirectToLogin()) setProblem("loop");
        return;
      }
      if (!res.ok) {
        if (initial) setProblem("notResponding");
        return;
      }

      const { token, user: me } = (await res.json()) as { token: string; user: SatelliteUser };
      if (cancelled) return;
      // Someone else signed in on the portal since this page loaded: start over as them, so nothing from the
      // previous user's tenant stays on screen.
      if (tokenRef.current && tokenRef.current !== token) {
        forgetSession();
        window.location.reload();
        return;
      }
      tokenRef.current = token;
      storeSession(token, me);
      resetLoginRedirects();
      setProblem(null);
      setUser(me);
    };

    sync(true);
    // Keep trying while the gateway is unreachable at first load.
    const retry = window.setInterval(() => { if (!tokenRef.current) sync(true); }, 4000);
    const onVisible = () => { if (document.visibilityState === "visible" && tokenRef.current) sync(false); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(retry);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!user) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-slate-50 px-6 text-center text-sm text-slate-500">
        {problem === null && (
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-200 border-t-blue-600" />
        )}
        <p>
          {problem === "unreachable"
            ? tx("Can't reach the sign-in service. Retrying…")
            : problem === "notResponding"
              ? tx("The sign-in service isn't responding. Retrying…")
              : problem === "loop"
                ? tx("Signing in keeps failing in this browser. Sign in on the portal, then reload this page.")
                : tx("Signing you in…")}
        </p>
        {problem === "loop" && (
          <a href={`${PORTAL_URL}/login`} className="text-xs font-semibold text-blue-600 hover:underline">
            {tx("Open the portal sign-in")}
          </a>
        )}
      </div>
    );
  }

  // A platform administrator has no tenant, so there is no tenant work here (the portal hides these apps for them
  // too). The APIs would refuse the requests anyway.
  if (!user.tenant_id) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-slate-50 px-6 text-center">
        <p className="text-sm font-semibold text-slate-700">{noTenant?.title ?? tx("This app works inside a tenant.")}</p>
        <p className="max-w-md text-xs text-slate-500">
          {noTenant?.body ?? tx("Your account ({role}) is not part of a tenant.", { role: user.role_name })}
        </p>
        <a href={PORTAL_URL} className="text-xs font-semibold text-blue-600 hover:underline">
          {tx("← Back to the portal")}
        </a>
      </div>
    );
  }

  return <SessionContext.Provider value={user}>{children}</SessionContext.Provider>;
}

// Exported for the shell's sign-out, which must forget the same things.
export { forgetSession };
