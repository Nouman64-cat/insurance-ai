"use client";

import { Suspense, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import SsoGate from "./SsoGate";
import WorkbenchShell from "./WorkbenchShell";
import RoleWorkspace from "./SpecialistWorkspace";

// Pages that must render without a session: the explanation middleware.ts shows when sign-in keeps bouncing.
const PUBLIC_PATHS = new Set(["/sso-problem"]);

export default function Protected({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (PUBLIC_PATHS.has(pathname)) return <>{children}</>;
  return (
    <SsoGate>
      <Suspense fallback={null}>
        <WorkbenchShell><RoleWorkspace>{children}</RoleWorkspace></WorkbenchShell>
      </Suspense>
    </SsoGate>
  );
}
