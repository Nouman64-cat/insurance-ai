"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import SsoGate, { OpenSessionProvider, type SatelliteUser } from "@/components/satellite/SsoGate";
import { OPEN_DESK, api } from "@/lib/api";
import { Spinner } from "@/components/satellite/ui";

// Normally the portal's session gates this app. The open desk (a separate deployment of the same app) has no sign-in: it asks the
// service who it is acting as and carries on.
function Open({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SatelliteUser | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.get("/me").then((r) => setUser({ id: r.data.id, email: r.data.email, full_name: r.data.full_name, tenant_id: r.data.tenant_id, tenant_name: "Open desk (development)", role_name: r.data.role_name, branch_id: null }))
      .catch(() => setFailed(true));
  }, []);
  if (failed) return <div className="p-10 text-center text-sm text-slate-600">The open desk is switched off or not configured on the Customer Service service (CS_OPEN_DESK, CS_OPEN_DESK_TENANT_ID).</div>;
  if (!user) return <Spinner />;
  return <OpenSessionProvider user={user}>{children}</OpenSessionProvider>;
}

export default function Protected({ children }: { children: React.ReactNode }) {
  if (usePathname() === "/sso-problem") return <>{children}</>;
  return OPEN_DESK ? <Open>{children}</Open> : <SsoGate>{children}</SsoGate>;
}
