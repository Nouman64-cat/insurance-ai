// Canonical message/event shape shared by Chatbot.tsx and CopilotInterface.tsx,
// replacing three previously-incompatible inline interfaces (Chatbot.tsx's
// `Message`, CopilotInterface.tsx's `ChatMessage`, VoiceOverlay.tsx's `Caption`
// — the last of those stays voice-specific since captions are transient, not
// persisted chat history).

export interface QuickAction {
  label: string;
  // "select" renders an inline dropdown instead of a chip — used wherever the
  // choice is a live list too long for chips (a rule category, a policy to
  // claim against, an adjuster). Picking a value runs `payload` with the
  // {value} placeholder substituted, through the same path a "submit" chip
  // takes, so it resumes a pending clarify interrupt or starts a new turn
  // exactly as typing the sentence would have.
  // "embed" is distinct from "navigate": it opens the destination inline in
  // the chat's case panel instead of a new tab. Used for the underwriting
  // process (case view, gates, workbench, results) and the customer intake
  // form — everywhere else in the app still opens a normal new tab via "navigate".
  // "proposal_step" is handled in the browser, not sent to the model: it moves a
  // proposal one status forward (payload is JSON, see CopilotInterface).
  actionType: "navigate" | "submit" | "upload" | "confirm" | "select" | "download" | "embed" | "proposal_step" | "uw_requirements";
  payload: string;
  // "select" only.
  options?: { label: string; value: string }[];
  placeholder?: string;
}

export interface ActionResult {
  toolName: string;
  entityType: string;
  entityId: string;
  route: string;
  label: string;
}

export interface RiskFactor {
  category?: string;
  factor?: string;
  parameter?: string;
  observation?: string;
  risk_rating?: string;
  risk_level?: string;
}

export interface AssessmentScores {
  scores: {
    medical_score: number;
    financial_score: number;
    fraud_probability: number;
    composite_score?: number;
    composite_risk_score?: number;
  };
  recommendation?: string;
  ai_decision?: string;
  case_id?: string;
  reasons?: RiskFactor[];
  medical_reasons?: RiskFactor[];
  financial_reasons?: RiskFactor[];
  fraud_reasons?: RiskFactor[];
}

export type PendingInterrupt =
  | { kind: "clarify"; question: string; options?: string[]; toolCall: { name: string; args: Record<string, any> } }
  | { kind: "confirm"; question: string; options?: string[]; toolCall: { name: string; args: Record<string, any> } }
  | { kind: "client_execute"; toolCall: { name: string; args: Record<string, any> } };

export interface FamilyMember {
  name?: string;
  cnic?: string;
  dob?: string;
  gender?: string;
  occupation?: string;
  declared_income?: number;
  relationship?: string;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachments?: { name: string; url: string }[];
  quickActions?: QuickAction[];
  // Which option was picked in each "select" quick action, keyed by the
  // action's index. Lives on the message (not in component state) so an
  // answered dropdown stays answered after switching chats or reloading.
  selections?: Record<number, string>;
  actionResult?: ActionResult;
  steps?: ProcessStep[];
  assessment?: AssessmentScores;
  familyMembers?: FamilyMember[];
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
      custom_actions?: QuickAction[];
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
  | { type: "navigate"; route: string; entity_id: string; highlight: boolean; embed?: boolean }
  | { type: "proposal_journey"; customer_id: string; name: string; family_group_id?: string; case_numbers?: string[]; cases?: { case_id: string; case_number: string; name: string; relationship: string }[] }
  | { type: "assessment"; assessment: AssessmentScores }
  | { type: "family_members"; family_members: FamilyMember[] }
  | { type: "done"; thread_id: string }
  | { type: "error"; message: string };
