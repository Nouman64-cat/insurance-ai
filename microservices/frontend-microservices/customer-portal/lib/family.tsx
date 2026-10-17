"use client";
// Whether this customer has family policies, shared by the shell (navigation), the dashboard and the pages that offer an
// Individual / Family switch. Customers with only individual policies get an empty list and see none of it.
import { createContext, ReactNode, useContext, useMemo } from "react";
import { useApi } from "./api";
import type { FamilyGroupSummary } from "./types";

interface FamilyCtx { families: FamilyGroupSummary[]; has: boolean; loading: boolean; reload: () => void }
const Ctx = createContext<FamilyCtx>({ families: [], has: false, loading: false, reload: () => undefined });

export function FamilyProvider({ children }: { children: ReactNode }) {
  const { data, loading, reload } = useApi<{ items: FamilyGroupSummary[] }>("family");
  const value = useMemo(() => ({ families: data?.items ?? [], has: (data?.items.length ?? 0) > 0, loading, reload }), [data, loading, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useFamilies = () => useContext(Ctx);
