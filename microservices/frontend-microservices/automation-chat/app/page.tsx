"use client";

import { CopilotInterface } from "@/components/CopilotInterface";

export default function AutomationChatPage() {
  return (
    <main className="relative flex h-screen overflow-hidden bg-slate-50">
      <div className="relative z-30 h-full flex-1 overflow-hidden bg-slate-50">
        <CopilotInterface />
      </div>
    </main>
  );
}
