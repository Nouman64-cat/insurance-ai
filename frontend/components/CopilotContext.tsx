"use client";

import React, { createContext, useContext, useState, ReactNode } from "react";

interface CopilotContextType {
  isAutomationMode: boolean;
  setAutomationMode: (value: boolean) => void;
}

const CopilotContext = createContext<CopilotContextType | undefined>(undefined);

export function CopilotProvider({ children }: { children: ReactNode }) {
  const [isAutomationMode, setAutomationMode] = useState(false);

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
