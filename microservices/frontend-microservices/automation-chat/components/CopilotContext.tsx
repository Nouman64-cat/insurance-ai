"use client";

import React, { createContext, useContext, ReactNode } from "react";
import { homeUrlFor } from "@/lib/portal";

// In this app the copilot IS the application, so automation mode is always on. Leaving it (the "manual
// dashboard" buttons inside the chat) goes to the signed-in role's own dashboard — the portal for most roles, the
// Underwriting Workbench for Medical / Financial Underwriters, the Claims Manager app for claims managers.
interface CopilotContextType {
  isAutomationMode: boolean;
  setAutomationMode: (value: boolean) => void;
}

const CopilotContext = createContext<CopilotContextType | undefined>(undefined);

export function CopilotProvider({ children }: { children: ReactNode }) {
  const setAutomationMode = (value: boolean) => {
    if (!value && typeof window !== "undefined") {
      let role = "";
      try { role = localStorage.getItem("user_role") ?? ""; } catch { /* storage blocked: default dashboard */ }
      window.location.assign(homeUrlFor(role));
    }
  };
  return <CopilotContext.Provider value={{ isAutomationMode: true, setAutomationMode }}>{children}</CopilotContext.Provider>;
}

export function useCopilot() {
  const context = useContext(CopilotContext);
  if (context === undefined) throw new Error("useCopilot must be used within a CopilotProvider");
  return context;
}
