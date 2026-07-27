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
  // specific record). Navigation is a component concern — the hook only relays.
  onNavigate?: (route: string, entityId: string, highlight: boolean) => void;
}

export function useAgentChat({ storageKey, welcomeMessage, onNavigate }: UseAgentChatOptions) {
  const { notify } = useNotify();
  const threadStorageKey = `${storageKey}_thread_id`;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

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
            setMessages((prev) => [...prev, { id: newId(), role: "assistant", text: evt.content }]);
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
            kind === "confirm"
              ? (evt.options || ["Yes", "Cancel"]).map((label) => ({ label, actionType: "confirm", payload: label }))
              : undefined;
          setPendingInterrupt(
            kind === "confirm"
              ? { kind: "confirm", question, options: evt.options, toolCall }
              : { kind: "clarify", question, toolCall }
          );
          setMessages((prev) => [...prev, { id: newId(), role: "assistant", text: question, quickActions }]);
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
          // The backend attaches contextual next-step suggestions to every
          // tool result — surface the freshest set as this turn's
          // recommendations (rendered as the chips under the chat input).
          setTurnActions(evt.actions || []);
          break;

        case "step":
          // Upsert by id: a step arrives "active" first, then settles to
          // "done"/"error". A settle for an id we never saw (e.g. after an
          // interrupt/resume where the "active" fired in the previous stream)
          // is inserted directly in its settled state.
          setSteps((prev) => {
            const idx = prev.findIndex((s) => s.id === evt.id);
            if (idx === -1) return [...prev, { id: evt.id, label: evt.label, status: evt.status }];
            const copy = [...prev];
            copy[idx] = { ...copy[idx], status: evt.status, label: evt.label };
            return copy;
          });
          break;

        case "navigate":
          onNavigateRef.current?.(evt.route, evt.entity_id, evt.highlight);
          break;

        case "done":
          setIsLoading(false);
          break;

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
    async (text: string) => {
      if (!text.trim() || isLoading) return;
      setPendingInterrupt(null);
      setSteps([]);
      setMessages((prev) => [...prev, { id: newId(), role: "user", text: text.trim() }]);
      setIsLoading(true);
      try {
        const res = await fetch("/api/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ thread_id: threadIdRef.current, message: text.trim(), role: currentRole() }),
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

  return { messages, send, resolveInterrupt, isLoading, pendingInterrupt, clearChat, loadChat, steps, turnActions };
}
