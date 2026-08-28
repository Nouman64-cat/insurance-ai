"use client";

import React, { createContext, useContext, useState, ReactNode } from "react";

interface CopilotContextType {
  isAutomationMode: boolean;
  setAutomationMode: (value: boolean) => void;
}

const CopilotContext = createContext<CopilotContextType | undefined>(undefined);

export function CopilotProvider({ children }: { children: ReactNode }) {
  const [isAutomationMode, setIsAutomationModeState] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      try {
        // If this tab was opened from the chatbot via _portal=1, always show
        // the portal (never the automation/chatbot interface) regardless of the
        // persisted localStorage flag.
        const params = new URLSearchParams(window.location.search);
        if (params.get("_portal") === "1") return false;
        return localStorage.getItem("copilot_automation_mode") === "true";
      } catch {}
    }
    return false;
  });

  const setAutomationMode = (value: boolean) => {
    setIsAutomationModeState(value);
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("copilot_automation_mode", String(value));
      } catch {}
    }
  };

  return (
    <CopilotContext.Provider value={{ isAutomationMode, setAutomationMode }}>
      {children}
    </CopilotContext.Provider>
  );
}

export function useCopilot() {
  const context = useContext(CopilotContext);
  if (context === undefined) {
    throw new Error("useCopilot must be used within a CopilotProvider");
  }
  return context;
}
