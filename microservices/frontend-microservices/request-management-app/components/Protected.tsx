"use client";

import { Suspense, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import SsoGate from "@/components/satellite/SsoGate";
import { tx } from "@/lib/i18n/tx";
import RequestsShell from "./RequestsShell";

// Pages that must render without a session: the explanation middleware.ts shows when sign-in keeps bouncing.
const PUBLIC_PATHS = new Set(["/sso-problem"]);

export default function Protected({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (PUBLIC_PATHS.has(pathname)) return <>{children}</>;
  return (
    <SsoGate noTenant={{ title: tx("Request Management works inside a tenant."), body: tx("Your account is not part of a tenant, so it has no requests.") }}>
      <Suspense fallback={null}>
        <RequestsShell>{children}</RequestsShell>
      </Suspense>
    </SsoGate>
  );
}
