"use client";

import { PORTAL_URL } from "@/lib/appLinks";
import { tx } from "@/lib/i18n/tx";

// Shown by middleware.ts after the portal sent the user back here several times without a sign-in cookie this app
// can read. Usually SSO_COOKIE_DOMAIN doesn't cover both hosts, or the browser blocks the cookie.
export default function SsoProblemPage() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-slate-50 px-6 text-center">
      <p className="text-sm font-semibold text-slate-700">{tx("This app can't see your portal sign-in.")}</p>
      <p className="max-w-lg text-xs text-slate-500">
        {tx("The portal signed you in, but its sign-in cookie doesn't reach this app. Ask an administrator to check that SSO_COOKIE_DOMAIN covers both the portal and this app, then try again.")}
      </p>
      <a href={`${PORTAL_URL}/login`} className="text-xs font-semibold text-blue-600 hover:underline">
        {tx("Open the portal sign-in")}
      </a>
    </div>
  );
}
