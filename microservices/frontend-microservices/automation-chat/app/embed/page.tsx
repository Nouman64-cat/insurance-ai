"use client";
import { CopilotInterface } from "@/components/CopilotInterface";

// Same provider/session and conversation storage as the full app, with compact chrome.
export default function EmbeddedAutomationChat() {
  return <main className="flex h-dvh min-h-0 overflow-hidden bg-white"><CopilotInterface compact /></main>;
}
