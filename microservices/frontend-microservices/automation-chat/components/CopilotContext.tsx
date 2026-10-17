"use client";

import React, { createContext, useContext, ReactNode } from "react";
import { PORTAL_URL } from "@/lib/portal";

// In this app the copilot IS the application, so automation mode is always on. Leaving it (the "manual
// dashboard" buttons inside the chat) goes back to the portal, which is a separate app on its own origin.
interface CopilotContextType {
  isAutomationMode: boolean;
  setAutomationMode: (value: boolean) => void;
}

const CopilotContext = createContext<CopilotContextType | undefined>(undefined);

export function CopilotProvider({ children }: { children: ReactNode }) {
  const setAutomationMode = (value: boolean) => {
    if (!value && typeof window !== "undefined") window.location.assign(PORTAL_URL);
  };
  return <CopilotContext.Provider value={{ isAutomationMode: true, setAutomationMode }}>{children}</CopilotContext.Provider>;
}

export function useCopilot() {
  const context = useContext(CopilotContext);
  if (context === undefined) throw new Error("useCopilot must be used within a CopilotProvider");
  return context;
}
