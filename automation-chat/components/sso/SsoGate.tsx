"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import api from "@/app/services/api";
import { PORTAL_URL } from "@/lib/portal";
import { useI18n } from "@/lib/i18n/I18nProvider";

// Signs this app in from the portal's session. Nothing to type: if the user is signed in on the manual dashboard
// they are signed in here, as the same user. If they are not, they are sent to the portal's sign-in page and
// brought back here afterwards. It also re-checks when the tab comes back into view, so signing out of (or
// switching user on) the portal is reflected here too.

const STORAGE_KEYS = ["jwt_token", "tenant_id", "tenant_name", "user_email", "user_name", "user_role", "branch_id"];

function toPortalLogin() {
  window.location.replace(`${PORTAL_URL}/login?next=${encodeURIComponent(window.location.href)}`);
}

function clearLocal() {
  try { STORAGE_KEYS.forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
  delete api.defaults.headers.common["Authorization"];
  delete api.defaults.headers.common["X-Tenant-Id"];
}

export default function SsoGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const sync = async (initial: boolean) => {
      let res: Response;
      try {
        res = await fetch("/api/sso/session", { cache: "no-store", credentials: "same-origin" });
      } catch {
        if (initial && !cancelled) setProblem(t("sso.unreachable"));
        return;
      }
      if (cancelled) return;
      if (res.status === 401) { clearLocal(); toPortalLogin(); return; }
      if (!res.ok) { if (initial) setProblem(t("sso.notResponding")); return; }

      const { token, user } = await res.json();
      // A different person signed in on the portal since this page loaded: start over as them.
      if (tokenRef.current && tokenRef.current !== token) { window.location.reload(); return; }
      tokenRef.current = token;

      try {
        localStorage.setItem("jwt_token", token);
        if (user.tenant_id) localStorage.setItem("tenant_id", user.tenant_id); else localStorage.removeItem("tenant_id");
        localStorage.setItem("user_email", user.email ?? "");
        localStorage.setItem("user_name", user.full_name ?? "");
        localStorage.setItem("user_role", user.role_name ?? "");
        if (user.branch_id) localStorage.setItem("branch_id", user.branch_id); else localStorage.removeItem("branch_id");
      } catch { /* storage unavailable: the headers below still work for this page */ }
      api.defaults.headers.common["Authorization"] = `Bearer ${token}`;
      if (user.tenant_id) api.defaults.headers.common["X-Tenant-Id"] = user.tenant_id;
      setProblem(null);
      setReady(true);
    };

    sync(true);
    const retry = window.setInterval(() => { if (!tokenRef.current) sync(true); }, 4000);
    const onVisible = () => { if (document.visibilityState === "visible" && tokenRef.current) sync(false); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(retry);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
        {problem ?? t("sso.signingIn")}
      </div>
    );
  }
  return <>{children}</>;
}
