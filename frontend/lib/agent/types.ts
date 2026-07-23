// Canonical message/event shape shared by Chatbot.tsx and CopilotInterface.tsx,
// replacing three previously-incompatible inline interfaces (Chatbot.tsx's
// `Message`, CopilotInterface.tsx's `ChatMessage`, VoiceOverlay.tsx's `Caption`
// — the last of those stays voice-specific since captions are transient, not
// persisted chat history).

export interface QuickAction {
  label: string;
  actionType: "navigate" | "submit" | "upload" | "confirm";
  payload: string;
}

export interface ActionResult {
  toolName: string;
  entityType: string;
  entityId: string;
  route: string;
  label: string;
}

export type PendingInterrupt =
  | { kind: "clarify"; question: string; toolCall: { name: string; args: Record<string, any> } }
  | { kind: "confirm"; question: string; options?: string[]; toolCall: { name: string; args: Record<string, any> } }
  | { kind: "client_execute"; toolCall: { name: string; args: Record<string, any> } };

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  quickActions?: QuickAction[];
  actionResult?: ActionResult;
}

// One node in the live process graph the agent narrates while working.
// Steps arrive twice: status "active" when the node starts, then "done"/"error"
// when it settles — upsert by `id`.
export interface ProcessStep {
  id: string;
  label: string;
  status: "active" | "done" | "error";
}

// SSE event payloads emitted by chat-agent (via api-gateway's /chat/stream, /chat/resume)
export type AgentStreamEvent =
  | { type: "token"; content: string }
  | {
      type: "interrupt";
      thread_id: string;
      kind: "clarify" | "confirm" | "client_execute";
      question?: string;
      options?: string[];
      tool_call: { name: string; args: Record<string, any> };
    }
  | {
      type: "action_completed";
      tool_name: string;
      entity_type: string;
      entity_id: string;
      route: string;
      label: string;
    }
  | { type: "quick_actions"; actions: QuickAction[] }
  | { type: "step"; id: string; label: string; status: ProcessStep["status"] }
  | { type: "navigate"; route: string; entity_id: string; highlight: boolean }
  | { type: "done"; thread_id: string }
  | { type: "error"; message: string };
