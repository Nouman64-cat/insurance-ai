"use client";

import type { ReactNode } from "react";
import { useSatelliteUser } from "@/components/satellite/SsoGate";
import { PORTAL_URL } from "@/lib/appLinks";
import { signOut } from "@/lib/sso";
import { tx } from "@/lib/i18n/tx";

// This portal is the claims manager's own workspace, with its own sign-in account. Other roles (Admin included) work
// with claims in the main portal, so they are sent back there instead of seeing screens that are not theirs.
const ALLOWED = ["ClaimsManager"];

export default function RoleGate({ children }: { children: ReactNode }) {
  const user = useSatelliteUser();
  if (ALLOWED.includes(user.role_name)) return <>{children}</>;
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-slate-50 px-6 text-center">
      <p className="text-base font-semibold text-slate-800">{tx("This portal is for claims managers.")}</p>
      <p className="max-w-md text-sm text-slate-500">
        {tx("You are signed in as {role}. Claims are handled for your role in the main portal.", { role: user.role_name })}
      </p>
      <div className="flex gap-2">
        <a href={PORTAL_URL} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">{tx("Go to the main portal")}</a>
        <button type="button" onClick={signOut} className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">{tx("Sign out")}</button>
      </div>
    </div>
  );
}
