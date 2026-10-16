"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { NavigationProgress } from "@/components/NavigationProgress";
import AutomationChatLauncher from "@/components/AutomationChatLauncher";
import AppHeader from "@/components/satellite/AppHeader";
import { tx } from "@/lib/i18n/tx";

// The frame: the app's name, its two sections, language, the way back to the portal and sign-out. Embedded
// (?_portal=1 or inside an iframe) it renders the page alone.
function useEmbedded(): boolean {
  const searchParams = useSearchParams();
  const [framed, setFramed] = useState(false);
  useEffect(() => { setFramed(window.parent !== window); }, []);
  return searchParams?.get("_portal") === "1" || framed;
}

export default function ClaimsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const embedded = useEmbedded();

  if (embedded) {
    return (
      <>
        <NavigationProgress />
        <main className="h-screen overflow-auto bg-slate-50">{children}</main>
      </>
    );
  }

  const sections = [
    { href: "/claims/dashboard", label: tx("Dashboard"), active: pathname.startsWith("/claims/dashboard") || pathname === "/dashboard" },
    { href: "/claims", label: tx("Claims Register"), active: pathname === "/claims" || pathname === "/claims/register" || (pathname.startsWith("/claims/") && !pathname.startsWith("/claims/dashboard")) },
  ];

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-50">
      <NavigationProgress />
      <AppHeader
        title={tx("Claims Manager")}
        home="/claims/dashboard"
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
            <path d="M9 12l2 2 4-4" /><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
        }
        sections={sections}
        sectionsLabel={tx("Claims Manager sections")}
      />
      <main className="relative flex-1 overflow-auto bg-slate-50">{children}</main>
      {/* The Claims Manager's Copilot: same chat as the portal, with the claims tools their role allows. */}
      <AutomationChatLauncher />
    </div>
  );
}
