"use client";

import type { ReactNode } from "react";
import { tx } from "@/lib/i18n/tx";
import SharedSsoGate, { useSatelliteUser, type SatelliteUser } from "@/components/satellite/SsoGate";

// The workbench's sign-in gate: the shared portal-SSO gate (components/satellite/SsoGate.tsx) with its own wording for
// accounts that have no tenant.
export type WorkbenchUser = SatelliteUser;
export const useWorkbenchUser = useSatelliteUser;

export default function SsoGate({ children }: { children: ReactNode }) {
  return (
    <SharedSsoGate
      noTenant={{
        title: tx("The Underwriting Workbench works inside a tenant."),
        body: tx("Your account is not part of a tenant, so there are no cases to underwrite here."),
      }}
    >
      {children}
    </SharedSsoGate>
  );
}
