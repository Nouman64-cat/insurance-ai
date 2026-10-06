"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useNotify } from "@/components/NotificationContext";
import type { AgentMessage, AgentStreamEvent, PendingInterrupt, ProcessStep, QuickAction } from "./types";

function newId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

function authHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const token = localStorage.getItem("jwt_token");
  const tenantId = localStorage.getItem("tenant_id");
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (tenantId) headers["X-Tenant-Id"] = tenantId;
  return headers;
}

function currentRole(): string {
  return typeof window !== "undefined" ? localStorage.getItem("user_role") || "Agent" : "Agent";
}

interface UseAgentChatOptions {
  storageKey: string;
  welcomeMessage?: AgentMessage;
  // Fired when a tool asks the browser to open a page (and optionally pop a
  // specific record). Navigation is a component concern — the hook only
  // relays. `embed` distinguishes the one case (a journey mid pre-underwriting)
  // that should open in the chat's inline case view instead of a new tab.
  onNavigate?: (route: string, entityId: string, highlight: boolean, embed?: boolean) => void;
  // A tool created a customer with a Draft proposal and wants the proposal steps
  // run in the chat. Fired once the reply has finished streaming, so the steps
  // land after the assistant's own message rather than racing it.
  // A family's proposal is found by `family.familyGroupId`; `family.caseNumbers` are its member cases.
  onProposalJourney?: (customerId: string, name: string, family?: FamilyJourney) => void;
}

/** A family proposal: its shared quote is found by `familyGroupId`; `cases` are the members' underwriting cases. */
export interface FamilyJourney {
  familyGroupId: string;
  caseNumbers: string[];
  /** Set when members were enrolled from the form: which policy, and whether each member has their own (life bundle). */
  familyPolicyId?: string;
  isLifeBundle?: boolean;
  cases: { case_id: string; case_number: string; name: string; relationship: string }[];
}

export function useAgentChat({ storageKey, welcomeMessage, onNavigate, onProposalJourney }: UseAgentChatOptions) {
  const { notify } = useNotify();
  const threadStorageKey = `${storageKey}_thread_id`;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const onProposalJourneyRef = useRef(onProposalJourney);
  onProposalJourneyRef.current = onProposalJourney;
  const pendingProposalJourneyRef = useRef<{ customerId: string; name: string; family?: FamilyJourney } | null>(null);

  const [messages, setMessages] = useState<AgentMessage[]>(() => {
    if (typeof window === "undefined") return welcomeMessage ? [welcomeMessage] : [];
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // ignore
    }
    return welcomeMessage ? [welcomeMessage] : [];
  });
  const [isLoading, setIsLoading] = useState(false);
  const [pendingInterrupt, setPendingInterrupt] = useState<PendingInterrupt | null>(null);
  // Live process-graph of the current turn. Cleared when a new turn starts,
  // kept on screen after "done" so the user can review what just ran.
  const [steps, setSteps] = useState<ProcessStep[]>([]);
  // Backend-driven recommendations for THIS turn ("View Lead", "Create
  // Proposal", …) — each tool result carries a quick_actions set; the freshest
  // one becomes the chips under the input. Survives page reloads so the
  // suggestions don't vanish mid-journey.
  const [turnActions, setTurnActions] = useState<QuickAction[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      return JSON.parse(localStorage.getItem(`${storageKey}_actions`) || "[]");
    } catch {
      return [];
    }
  });
  const threadIdRef = useRef<string>("");
  const pendingAssessmentRef = useRef<any>(null);
  const pendingQuickActionsRef = useRef<QuickAction[] | null>(null);
  const pendingFamilyMembersRef = useRef<any>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(storageKey, JSON.stringify(messages));
  }, [messages, storageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(`${storageKey}_actions`, JSON.stringify(turnActions));
  }, [turnActions, storageKey]);

  // Each "token" event carries one fully-formed assistant message (the graph
  // does one Gemini call per agent turn, not real per-token streaming), so it
  // always starts a new bubble rather than appending to the previous one.
  const handleEvent = useCallback(
    (evt: AgentStreamEvent) => {
      switch (evt.type) {
        case "token":
          if (evt.content) {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === "assistant" && last.text === evt.content) {
                return prev;
              }
              const copy = [...prev];
              // Move the assessment (only) from any previous message in this turn to
              // the final token bubble. quickActions are deliberately NOT migrated
              // off older messages any more — a confirm/clarify interrupt's own
              // buttons (Yes/Cancel, Individual/Corporate/Family, …) must stay on
              // that message exactly as answered, not vanish because a later,
              // unrelated quick_actions event arrived for the next step.
              if (pendingAssessmentRef.current) {
                for (let i = copy.length - 1; i >= 0; i--) {
                  if (copy[i].role === "user") break;
                  if (copy[i].role === "assistant" && copy[i].assessment) {
                    copy[i] = { ...copy[i] };
                    delete copy[i].assessment;
                  }
                }
              }
              if (pendingFamilyMembersRef.current) {
                for (let i = copy.length - 1; i >= 0; i--) {
                  if (copy[i].role === "user") break;
                  if (copy[i].role === "assistant" && copy[i].familyMembers) {
                    copy[i] = { ...copy[i] };
                    delete copy[i].familyMembers;
                  }
                }
              }
              copy.push({
                id: newId(),
                role: "assistant",
                text: evt.content,
                assessment: pendingAssessmentRef.current || undefined,
                quickActions: pendingQuickActionsRef.current || undefined,
                familyMembers: pendingFamilyMembersRef.current || undefined,
              });
              return copy;
            });
            pendingAssessmentRef.current = null;
            pendingQuickActionsRef.current = null;
            pendingFamilyMembersRef.current = null;
          }
          break;

        case "interrupt": {
          const toolCall = evt.tool_call;
          if (evt.kind === "client_execute") {
            setPendingInterrupt({ kind: "client_execute", toolCall });
            break;
          }
          const kind = evt.kind;
          const question = evt.question || (kind === "confirm" ? "Proceed?" : "Could you clarify?");
          const quickActions: QuickAction[] | undefined =
            evt.custom_actions ||
            (kind === "confirm"
              ? (evt.options || ["Yes", "Cancel"]).map((label) => ({ label, actionType: "confirm", payload: label }))
              : kind === "clarify" && evt.options
              ? evt.options.map((label) => ({ label, actionType: "submit", payload: label }))
              : undefined);
          setPendingInterrupt(
            kind === "confirm"
              ? { kind: "confirm", question, options: evt.options, toolCall }
              : { kind: "clarify", question, options: evt.options, toolCall }
          );
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant" && last.text === question) {
              const copy = [...prev];
              copy[copy.length - 1] = { ...last, quickActions: quickActions || last.quickActions };
              return copy;
            }
            return [...prev, { id: newId(), role: "assistant", text: question, quickActions }];
          });
          break;
        }

        case "action_completed": {
          const actionResult = {
            toolName: evt.tool_name,
            entityType: evt.entity_type,
            entityId: evt.entity_id,
            route: evt.route,
            label: evt.label,
          };
          setMessages((prev) => {
            const copy = [...prev];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].role === "assistant") {
                copy[i] = { ...copy[i], actionResult };
                break;
              }
            }
            return copy;
          });
          notify(`✅ ${evt.label}`, true, evt.route);
          break;
        }

        case "quick_actions":
          // Buffered here so the token handler above attaches these to the
          // NEW bubble it's about to create for this turn's reply.
          pendingQuickActionsRef.current = evt.actions;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            // Backfill onto the current bubble only if it has no actions of
            // its own yet — never overwrite an interrupt's already-answered
            // Yes/Cancel (or similar) with this turn's next-step suggestions.
            if (last && last.role === "assistant" && !last.quickActions) {
              const copy = [...prev];
              copy[copy.length - 1] = { ...last, quickActions: evt.actions };
              return copy;
            }
            return prev;
          });
          // Also set turnActions for the floating panel (filter out upload actions
          // since they are already attached to the specific message bubble)
          setTurnActions(evt.actions ? evt.actions.filter((a: any) => a.actionType !== "upload") : []);
          break;

        case "step":
          // Upsert by id: a step arrives "active" first, then settles to
          // "done"/"error". A settle for an id we never saw (e.g. after an
          // interrupt/resume where the "active" fired in the previous stream)
          // is inserted directly in its settled state.
          const updateSteps = (prevSteps: ProcessStep[]) => {
            const idx = prevSteps.findIndex((s) => s.id === evt.id);
            if (idx === -1) return [...prevSteps, { id: evt.id, label: evt.label, status: evt.status }];
            const copy = [...prevSteps];
            copy[idx] = { ...copy[idx], status: evt.status, label: evt.label };
            return copy;
          };
          setSteps((prev) => updateSteps(prev));
          setMessages((prev) => {
            const copy = [...prev];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].role === "assistant") {
                copy[i] = { ...copy[i], steps: updateSteps(copy[i].steps || []) };
                break;
              }
            }
            return copy;
          });
          break;

        case "navigate":
          onNavigateRef.current?.(evt.route, evt.entity_id, evt.highlight, evt.embed);
          break;

        case "proposal_journey":
          pendingProposalJourneyRef.current = {
            customerId: evt.customer_id, name: evt.name,
            family: evt.family_group_id ? { familyGroupId: evt.family_group_id, caseNumbers: evt.case_numbers ?? [], cases: evt.cases ?? [] } : undefined,
          };
          break;

        case "assessment":
          pendingAssessmentRef.current = evt.assessment;
          // Also attach to the current message just in case no token event follows
          setMessages((prev) => {
            const copy = [...prev];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].role === "assistant") {
                copy[i] = { ...copy[i], assessment: evt.assessment };
                break;
              }
            }
            return copy;
          });
          break;

        case "family_members":
          pendingFamilyMembersRef.current = evt.family_members;
          setMessages((prev) => {
            const copy = [...prev];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].role === "assistant") {
                copy[i] = { ...copy[i], familyMembers: evt.family_members };
                break;
              }
            }
            return copy;
          });
          break;

        case "done": {
          setIsLoading(false);
          const pending = pendingProposalJourneyRef.current;
          if (pending) {
            pendingProposalJourneyRef.current = null;
            onProposalJourneyRef.current?.(pending.customerId, pending.name, pending.family);
          }
          break;
        }

        case "error":
          setMessages((prev) => [...prev, { id: newId(), role: "assistant", text: `⚠️ ${evt.message}` }]);
          setIsLoading(false);
          break;
      }
    },
    [notify]
  );

  const consumeStream = useCallback(
    async (res: Response) => {
      if (!res.ok || !res.body) {
        setMessages((prev) => [...prev, { id: newId(), role: "assistant", text: "⚠️ Error connecting to the server. Please try again." }]);
        setIsLoading(false);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;
            try {
              handleEvent(JSON.parse(line.slice(6)) as AgentStreamEvent);
            } catch {
              // ignore malformed chunk
            }
          }
        }
      } finally {
        setIsLoading(false);
      }
    },
    [handleEvent]
  );

  // Mount-time check: if this thread is paused at an interrupt (e.g. the user
  // reloaded the page mid-question), redisplay it instead of losing it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let tid = localStorage.getItem(threadStorageKey);
    if (!tid) {
      tid = newId();
      localStorage.setItem(threadStorageKey, tid);
    }
    threadIdRef.current = tid;

    fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ thread_id: tid, role: currentRole() }),
    })
      .then(consumeStream)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback(
    async (text: string, attachments?: { name: string, url: string }[]) => {
      if ((!text.trim() && (!attachments || attachments.length === 0)) || isLoading) return;
      setPendingInterrupt(null);
      setSteps([]);
      setTurnActions([]);
      
      let msgText = text.trim();
      setMessages((prev) => [...prev, { id: newId(), role: "user", text: msgText, attachments }]);
      setIsLoading(true);
      try {
        const payload: any = { thread_id: threadIdRef.current, message: text.trim(), role: currentRole() };
        if (attachments && attachments.length > 0) {
            payload.attachments = attachments;
        }
        const res = await fetch("/api/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify(payload),
        });
        await consumeStream(res);
      } catch {
        setMessages((prev) => [...prev, { id: newId(), role: "assistant", text: "⚠️ Error connecting to the server. Please try again." }]);
        setIsLoading(false);
      }
    },
    [isLoading, consumeStream]
  );

  const resolveInterrupt = useCallback(
    async (resumeValue: any) => {
      if (!pendingInterrupt) return;
      setPendingInterrupt(null);
      // A resume continues the same turn, so the process graph keeps growing
      // rather than restarting — but the "Waiting for you" node is now
      // answered, so settle it instead of leaving it pulsing forever.
      setSteps((prev) => prev.map((s) => (s.id.startsWith("wait:") && s.status === "active" ? { ...s, status: "done" } : s)));
      // Clear stale turnActions from a prior step, same as send() does — a
      // message with no quickActions of its own falls back to turnActions
      // for its buttons, and a leftover set from a previous turn must not
      // bleed onto an unrelated reply.
      setTurnActions([]);
      setIsLoading(true);
      try {
        const res = await fetch("/api/chat/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ thread_id: threadIdRef.current, resume_value: resumeValue }),
        });
        await consumeStream(res);
      } catch {
        setMessages((prev) => [...prev, { id: newId(), role: "assistant", text: "⚠️ Error connecting to the server. Please try again." }]);
        setIsLoading(false);
      }
    },
    [pendingInterrupt, consumeStream]
  );

    const loadChat = useCallback((loadedMessages: AgentMessage[], loadedActions: QuickAction[]) => {
    setMessages(loadedMessages);
    setTurnActions(loadedActions);
    setPendingInterrupt(null);
    setSteps([]);
  }, []);

  // For scenarios the client already knows the outcome of deterministically
  // (e.g. all pre-underwriting gates just cleared, observed directly via the
  // embedded case view) — appends a real assistant message with real
  // quick_actions straight into the conversation, no LLM round-trip. Asking
  // the model to "present exactly these two buttons" is unreliable: it can
  // narrate them as plain text instead of actually calling the tool that
  // would produce clickable ones.
  const addAssistantMessage = useCallback((text: string, quickActions?: QuickAction[]) => {
    setMessages((prev) => [...prev, { id: newId(), role: "assistant", text, quickActions }]);
    if (quickActions?.length) {
      setTurnActions(quickActions.filter((a) => a.actionType !== "upload"));
    }
  }, []);

  const recordSelection = useCallback((messageId: string, actionIdx: number, label: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, selections: { ...m.selections, [actionIdx]: label } } : m))
    );
  }, []);

  const clearChat = useCallback(() => {
    const tid = newId();
    localStorage.setItem(threadStorageKey, tid);
    threadIdRef.current = tid;
    setMessages(welcomeMessage ? [welcomeMessage] : []);
    setPendingInterrupt(null);
    setSteps([]);
    setTurnActions([]);
    localStorage.removeItem(storageKey);
    localStorage.removeItem(`${storageKey}_actions`);
  }, [storageKey, threadStorageKey, welcomeMessage]);

  return { messages, send, resolveInterrupt, isLoading, pendingInterrupt, clearChat, loadChat, steps, turnActions, addAssistantMessage, recordSelection };
}
