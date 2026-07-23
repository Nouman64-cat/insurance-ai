"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import VoiceOverlay from "./VoiceOverlay";
import { useRouter } from "next/navigation";
import api from "../app/services/api";
import { useNotify } from "./NotificationContext";
import { ProcessGraph } from "./ProcessGraph";
import { useAgentChat } from "@/lib/agent/useAgentChat";
import { requestHighlight, triggerHighlight } from "@/lib/useHighlightTarget";
import type { AgentMessage, QuickAction } from "@/lib/agent/types";

const WELCOME: AgentMessage = {
  id: "1",
  role: "assistant",
  text: "Hello! I am your AI Underwriting Copilot. I can help you onboard applicants, run risk assessments, or pull case details instantly. What would you like to automate today?",
};

const STORAGE_KEY = "copilot_history";
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

const actionIcons: Record<string, string> = {
  navigate: "🔗",
  submit: "▶️",
  upload: "📤",
  confirm: "✅",
};

function getRecommendedActions(lastMessage: AgentMessage | undefined): QuickAction[] {
  if (!lastMessage) {
    return [
      { label: "Add a new customer", actionType: "submit", payload: "Add a new customer" },
      { label: "Test with demo data", actionType: "submit", payload: "Test the full workflow with demo data" },
      { label: "View all cases", actionType: "navigate", payload: "underwriting" },
    ];
  }

  const text = (lastMessage.text || "").toLowerCase();
  if (text.includes("customer") && text.includes("added")) {
    return [
      { label: "Create case now", actionType: "submit", payload: "Create an underwriting case for the customer" },
      { label: "Add another customer", actionType: "submit", payload: "Add another customer" },
      { label: "View leads", actionType: "navigate", payload: "admin/customers" },
    ];
  }
  if (text.includes("case") && text.includes("created")) {
    return [
      { label: "Create proposal now", actionType: "submit", payload: "Create a proposal for the customer" },
      { label: "View case details", actionType: "navigate", payload: "cases" },
      { label: "Create another case", actionType: "submit", payload: "Create a case" },
    ];
  }
  if (text.includes("proposal") && text.includes("created")) {
    return [
      { label: "Run risk assessment", actionType: "submit", payload: "Run risk assessment" },
      { label: "Upload documents first", actionType: "submit", payload: "What documents are needed?" },
      { label: "View proposal", actionType: "navigate", payload: "proposal" },
    ];
  }
  if (text.includes("assessment") && (text.includes("complete") || text.includes("triggered"))) {
    return [
      { label: "Move to review", actionType: "submit", payload: "Update case status to Under Review" },
      { label: "Upload documents", actionType: "submit", payload: "Upload required documents" },
      { label: "View results", actionType: "navigate", payload: "underwriting" },
    ];
  }
  if (text.includes("review")) {
    return [
      { label: "Approve case", actionType: "submit", payload: "Approve the case" },
      { label: "Decline case", actionType: "submit", payload: "Decline the case" },
      { label: "Request documents", actionType: "submit", payload: "Request more documents" },
    ];
  }
  if (text.includes("approved") || text.includes("rejected")) {
    return [
      { label: "Close the case", actionType: "submit", payload: "Close the case" },
      { label: "Start new application", actionType: "submit", payload: "Add a new customer" },
    ];
  }
  return [
    { label: "What's next?", actionType: "submit", payload: "What should I do next?" },
    { label: "View all cases", actionType: "navigate", payload: "underwriting" },
    { label: "Add new customer", actionType: "submit", payload: "Add a new customer" },
  ];
}

export function CopilotInterface() {
  const router = useRouter();
  const { notify } = useNotify();

  // Tools like show_record answer with an explicit navigate instruction:
  // remember the target row, push the route, and the global record
  // highlighter pops it once the destination list has rendered.
  const handleAgentNavigate = useCallback(
    (route: string, entityId: string, highlight: boolean) => {
      if (highlight && entityId) {
        requestHighlight(entityId); // consumed by the watcher after navigation
        triggerHighlight(entityId); // covers the already-on-that-page case, where push() is a no-op
      }
      router.push(`/${route}`);
    },
    [router]
  );

  const { messages, send, resolveInterrupt, isLoading, pendingInterrupt, clearChat, steps, turnActions } = useAgentChat({
    storageKey: STORAGE_KEY,
    welcomeMessage: WELCOME,
    onNavigate: handleAgentNavigate,
  });

  const [input, setInput] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [autoSubmitPrompt, setAutoSubmitPrompt] = useState("");
  const [suggestedActions, setSuggestedActions] = useState<string[]>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem(STORAGE_KEY + "_suggestions");
        if (saved) return JSON.parse(saved);
      } catch {}
    }
    return [];
  });

  // Live clock for the phone status bar
  const [clock, setClock] = useState("");
  useEffect(() => {
    const update = () => setClock(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    update();
    const id = setInterval(update, 30000);
    return () => clearInterval(id);
  }, []);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chunksRef = useRef<Blob[]>([]);
  const selectedFileRef = useRef<File | null>(null);
  // Args for a directly-triggered upload (from a quick-action "Upload {doc}"
  // suggestion, which already knows document_type + cnic precisely) — as
  // opposed to an agent-initiated upload_document tool call, which arrives via
  // pendingInterrupt.kind === "client_execute" instead.
  const pendingUploadRef = useRef<{ document_type: string; cnic: string } | null>(null);

  useEffect(() => { selectedFileRef.current = selectedFile; }, [selectedFile]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, steps]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY + "_suggestions", JSON.stringify(suggestedActions));
  }, [suggestedActions]);

  // ── Document upload — the one tool the browser must execute itself, since
  // it's the only place holding the attached File object (see graph.py's
  // CLIENT_EXECUTED_TOOLS / permission_gate's "client_execute" interrupt kind).
  const uploadDocument = useCallback(async (args: { document_type: string; cnic?: string; applicant_name?: string }, file: File) => {
    const tenantId = localStorage.getItem("tenant_id") || DEFAULT_TENANT_ID;
    const list = await api.get(`/tenants/${tenantId}/cases`);
    const c = list.data.find((c: any) => {
      if (args.cnic && c.customer_cnic === args.cnic) return true;
      if (!args.applicant_name) return false;
      const n = args.applicant_name.toLowerCase();
      const fullName = `${c.applicant_name || ""} ${c.customer_name || ""}`.trim().toLowerCase();
      return fullName.includes(n) || c.applicant_name?.toLowerCase().includes(n) || c.customer_name?.toLowerCase().includes(n);
    });
    if (!c) throw new Error("No case found for this applicant.");
    const form = new FormData();
    form.append("document_type", args.document_type);
    form.append("file", file);
    await api.post(`/tenants/${tenantId}/cases/${c.caseld}/artifacts`, form, { headers: { "Content-Type": "multipart/form-data" } });

    // Rich result: when this resumes the graph, the SSE pipeline re-emits
    // last_action (toast + navigate + highlight) and quick_actions (the
    // recommendation chips) exactly as if a server-side tool had run.
    const caseRoute = `cases?case_id=${c.caseld}`;
    const who = args.cnic || args.applicant_name || "";
    return {
      success: true,
      message: `${args.document_type} (${file.name}) uploaded to case ${c.caseNumber || ""}.`,
      last_action: {
        tool_name: "upload_document",
        entity_type: "case",
        entity_id: c.caseld,
        route: caseRoute,
        label: `${args.document_type} uploaded`,
      },
      quick_actions: [
        { label: "View Documents", actionType: "navigate", payload: caseRoute },
        { label: "Check remaining documents", actionType: "submit", payload: `What documents are still needed for ${who}?` },
        { label: "Run Risk Assessment", actionType: "submit", payload: `Run risk assessment for ${who}` },
      ],
    };
  }, []);

  // Set while an agent-initiated upload (client_execute interrupt) is waiting
  // for the user to choose a file — the file input's onChange completes it.
  const interruptUploadRef = useRef<{ args: any } | null>(null);

  // An agent-initiated upload_document call arrives as a "client_execute"
  // interrupt once the user has confirmed it. If a file is already attached,
  // upload straight away; otherwise pop the browser's file picker so the user
  // can hand one over without leaving the chat — the whole upload then runs
  // automatically and the graph resumes with the result.
  useEffect(() => {
    if (pendingInterrupt?.kind !== "client_execute") return;
    if (pendingInterrupt.toolCall.name !== "upload_document") return;
    const file = selectedFileRef.current;
    if (!file) {
      interruptUploadRef.current = { args: pendingInterrupt.toolCall.args };
      notify("📎 Choose the file to upload — I'll handle the rest.", true);
      fileInputRef.current?.click();
      return;
    }
    (async () => {
      try {
        const result = await uploadDocument(pendingInterrupt.toolCall.args as any, file);
        setSelectedFile(null);
        resolveInterrupt(result);
      } catch (e: any) {
        resolveInterrupt({ success: false, error: e.message || "Upload failed." });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingInterrupt]);

  // ── Submit — a plain new turn, or the answer to a pending "clarify" question
  const handleSubmit = useCallback((e?: React.FormEvent, overrideText?: string) => {
    e?.preventDefault();
    const text = overrideText ?? input;
    if (!text.trim() || isLoading) return;
    if (!overrideText) setInput("");

    if (pendingInterrupt?.kind === "clarify") {
      resolveInterrupt(text.trim());
    } else if (pendingInterrupt?.kind === "confirm") {
      const lowerText = text.trim().toLowerCase();
      if (lowerText === "yes" || lowerText === "y") {
        resolveInterrupt(true);
      } else if (lowerText === "no" || lowerText === "n" || lowerText === "cancel") {
        resolveInterrupt(false);
      } else {
        send(text.trim());
      }
    } else {
      send(text.trim());
    }
  }, [input, isLoading, pendingInterrupt, send, resolveInterrupt]);

  const handleQuickAction = useCallback((action: QuickAction) => {
    if (action.actionType === "navigate") {
      // Payloads carry the destination page's own self-select param
      // ("cases?case_id=…", "admin/leads?cnic=…") — mirror it into the
      // highlighter so the row pops, not just loads.
      const query = action.payload.split("?")[1];
      const entityId = query ? new URLSearchParams(query).values().next().value : undefined;
      if (entityId) {
        requestHighlight(entityId);
        triggerHighlight(entityId); // same-URL pushes don't re-fire the nav watcher
      }
      router.push(`/${action.payload}`);
    } else if (action.actionType === "upload") {
      const data = JSON.parse(action.payload);
      pendingUploadRef.current = data;
      fileInputRef.current?.click();
    } else if (action.actionType === "confirm") {
      resolveInterrupt(action.payload === "Yes");
    } else {
      handleSubmit(undefined, action.payload);
    }
  }, [router, resolveInterrupt, handleSubmit]);

  // Fire RAG "next best action" suggestions once a turn finishes — fire-and-
  // forget, completely off the critical path.
  const wasLoadingRef = useRef(false);
  useEffect(() => {
    if (wasLoadingRef.current && !isLoading) {
      const tenantId = localStorage.getItem("tenant_id");
      if (tenantId) {
        const ctx = messages.slice(-4).map((m) => `${m.role}: ${m.text}`).join("\n");
        api.post("/agent/suggest-actions", { context: ctx, tenant_id: tenantId })
          .then((r) => setSuggestedActions(r.data?.suggested_actions?.length > 0 ? r.data.suggested_actions : []))
          .catch(() => {});
      }
    }
    wasLoadingRef.current = isLoading;
  }, [isLoading, messages]);

  const handleClearChat = () => {
    clearChat();
    setSuggestedActions([]);
    localStorage.removeItem(STORAGE_KEY + "_suggestions");
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: mr.mimeType });
        try {
          const fd = new FormData();
          fd.append("audio", blob, "recording.webm");
          const sttRes = await fetch("/api/stt", { method: "POST", body: fd });
          if (!sttRes.ok) throw new Error("STT failed");
          const { transcript } = await sttRes.json();
          if (transcript?.trim()) await handleSubmit(undefined, transcript);
        } catch {
          notify("⚠️ Could not transcribe audio. Please try again.", false);
        }
      };
      mr.start();
      setIsRecording(true);
    } catch {
      alert("Microphone access denied. Please allow microphone access in your browser.");
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  };

  return (
    <div className="flex flex-col h-full relative overflow-hidden">
      {/* ── Clean white backdrop ───────────────────────────────────────── */}
      <div className="absolute inset-0 bg-slate-50" />

      {showVoice && <VoiceOverlay onClose={() => setShowVoice(false)} />}

      {/* ── Phone Frame ────────────────────────────────────────────────── */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center p-3 sm:p-5 min-h-0">
        <div className="w-full max-w-[420px] flex-1 flex flex-col bg-slate-900 rounded-[2.75rem] p-2.5 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.6)] ring-1 ring-white/20 min-h-0 animate-in fade-in zoom-in-95 duration-500">
          {/* Screen */}
          <div className="relative flex-1 flex flex-col bg-white rounded-[2.25rem] overflow-hidden min-h-0">

            {/* ── Status Bar ─────────────────────────────────────────── */}
            <div className="flex-shrink-0 relative bg-gradient-to-r from-violet-600 to-fuchsia-600 pt-2 pb-1 px-6 flex items-center justify-between text-white text-[11px] font-semibold">
              <span className="tabular-nums">{clock || "9:41"}</span>
              {/* Notch */}
              <div className="absolute left-1/2 -translate-x-1/2 top-1.5 w-24 h-5 bg-slate-900 rounded-full" />
              <div className="flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><rect x="2" y="14" width="3" height="6" rx="1"/><rect x="7" y="10" width="3" height="10" rx="1"/><rect x="12" y="6" width="3" height="14" rx="1"/><rect x="17" y="2" width="3" height="18" rx="1"/></svg>
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 18a2 2 0 100 4 2 2 0 000-4zm0-5c1.7 0 3.3.66 4.5 1.8l-1.4 1.4A4.5 4.5 0 009 16.2l-1.4-1.4A6.4 6.4 0 0112 13zm0-4.5c2.9 0 5.6 1.15 7.6 3.1l-1.4 1.4A9 9 0 006 13.1l-1.4-1.4A10.7 10.7 0 0112 8.5z"/></svg>
                <svg className="w-6 h-3.5" viewBox="0 0 28 14" fill="none"><rect x="1" y="1" width="22" height="12" rx="3" stroke="currentColor" strokeWidth="1.5"/><rect x="3" y="3" width="16" height="8" rx="1.5" fill="currentColor"/><rect x="24.5" y="4.5" width="2" height="5" rx="1" fill="currentColor"/></svg>
              </div>
            </div>

            {/* ── Chat Header ────────────────────────────────────────── */}
            <div className="flex-shrink-0 bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 pb-3 pt-1 flex items-center justify-between text-white shadow-lg">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center shadow-md overflow-hidden ring-2 ring-white/40">
                    <img src="/rizvi.png" alt="Rizviz" className="w-7 h-7 object-contain" />
                  </div>
                  <span className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-emerald-400 ring-2 ring-violet-600" />
                </div>
                <div className="flex flex-col leading-tight">
                  <span className="text-[15px] font-bold tracking-tight">Rizviz AI Agent</span>
                  <span className="text-[11px] text-white/80 font-medium flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-300 animate-pulse" /> Online · Automation
                  </span>
                </div>
              </div>
              <button onClick={handleClearChat} title="Clear chat" className="p-2 rounded-full hover:bg-white/15 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
              </button>
            </div>

            {/* ── Chat Feed ──────────────────────────────────────────── */}
            <div className="flex-1 overflow-y-auto px-3.5 py-4 relative bg-gradient-to-b from-violet-50 via-white to-fuchsia-50">
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-[0.04] z-0">
                <img src="/rizvi.png" alt="" className="w-1/2 max-w-[200px] object-contain" />
              </div>
              <div className="relative z-10 space-y-4 pb-2">
                {messages.map((msg) => (
                  <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} items-end gap-2 group animate-in slide-in-from-bottom-2 duration-300`}>
                    {msg.role === "assistant" && (
                      <div className="w-7 h-7 rounded-full bg-white border border-violet-100 shadow-sm flex flex-shrink-0 items-center justify-center overflow-hidden">
                        <img src="/rizvi.png" alt="Agent" className="w-5 h-5 object-contain" />
                      </div>
                    )}
                    <div className={`max-w-[82%] px-4 py-2.5 text-[14px] leading-relaxed shadow-sm flex flex-col gap-3 ${
                      msg.role === "user"
                        ? "bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white rounded-2xl rounded-br-md"
                        : "bg-white border border-slate-100 text-slate-700 rounded-2xl rounded-bl-md"
                    }`}>
                      {msg.role === "user" ? (
                        <div className="whitespace-pre-wrap">{msg.text}</div>
                      ) : (
                        <div className="copilot-markdown">
                          <ReactMarkdown>{msg.text}</ReactMarkdown>
                        </div>
                      )}
                      {msg.quickActions && msg.quickActions.length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-1">
                          {msg.quickActions.map((action, idx) => (
                            <button
                              key={`${action.actionType}-${action.label}-${idx}`}
                              onClick={() => handleQuickAction(action)}
                              className={`px-3 py-1.5 text-[12px] font-bold rounded-full border transition-all flex items-center gap-1.5 shadow-sm active:scale-95 ${
                                action.actionType === "navigate"
                                  ? "bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200"
                                  : action.actionType === "upload"
                                  ? "bg-amber-50 hover:bg-amber-100 text-amber-700 border-amber-200"
                                  : action.actionType === "confirm"
                                  ? "bg-violet-50 hover:bg-violet-100 text-violet-700 border-violet-200"
                                  : "bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border-indigo-200"
                              }`}
                            >
                              {action.actionType === "navigate" ? (
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                              ) : action.actionType === "upload" ? (
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                              ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v8"/></svg>
                              )}
                              {action.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {/* Live process graph — the agent narrating its own state
                    machine, node by node, while (and after) it works. */}
                {steps.length > 0 && (
                  <div className="flex justify-start items-start gap-2">
                    <div className="w-7 h-7 rounded-full bg-white border border-violet-100 shadow-sm flex flex-shrink-0 items-center justify-center overflow-hidden">
                      <img src="/rizvi.png" alt="Agent" className="w-5 h-5 object-contain" />
                    </div>
                    <div className="max-w-[82%] flex-1">
                      <ProcessGraph steps={steps} />
                    </div>
                  </div>
                )}
                {isLoading && (
                  <div className="flex justify-start items-end gap-2">
                    <div className="w-7 h-7 rounded-full bg-white border border-violet-100 shadow-sm flex flex-shrink-0 items-center justify-center overflow-hidden">
                      <img src="/rizvi.png" alt="Agent" className="w-5 h-5 object-contain" />
                    </div>
                    <div className="flex items-center gap-1.5 bg-white rounded-2xl rounded-bl-md px-4 py-3 shadow-sm border border-slate-100">
                      {[0, 1, 2].map(i => (
                        <span key={i} className="w-2 h-2 rounded-full bg-fuchsia-400 animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
                      ))}
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* ── Input Area ─────────────────────────────────────────── */}
            <div className="flex-shrink-0 px-3 pt-2.5 pb-3 bg-white border-t border-slate-100">
              {selectedFile && (
                <div className="mb-2 flex items-center gap-2">
                  <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-violet-50 text-violet-700 text-xs font-semibold rounded-full border border-violet-100">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                    {selectedFile.name}
                    <button type="button" onClick={() => setSelectedFile(null)} className="ml-1 hover:text-violet-900 transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                </div>
              )}
              <form onSubmit={handleSubmit} className="flex items-end gap-2">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setSelectedFile(file);
                    selectedFileRef.current = file;

                    if (interruptUploadRef.current) {
                      // Agent-initiated upload: picker was auto-opened by the
                      // client_execute interrupt — upload now and resume the
                      // graph so the agent narrates the result + next steps.
                      const { args } = interruptUploadRef.current;
                      interruptUploadRef.current = null;
                      try {
                        const result = await uploadDocument(args, file);
                        setSelectedFile(null);
                        resolveInterrupt(result);
                      } catch (err: any) {
                        setSelectedFile(null);
                        resolveInterrupt({ success: false, error: err.message || "Upload failed." });
                      }
                    } else if (pendingUploadRef.current) {
                      // Quick-action upload ("Upload Salary Slip" chip): upload
                      // directly, then hand the outcome to the agent so the
                      // conversation moves forward with fresh recommendations.
                      const args = pendingUploadRef.current;
                      pendingUploadRef.current = null;
                      try {
                        const result = await uploadDocument(args, file);
                        notify(`✅ ${result.message}`, true);
                        send(`I've uploaded the ${args.document_type}${args.cnic ? ` for CNIC ${args.cnic}` : ""}. What's the next step?`);
                      } catch (err: any) {
                        notify(`⚠️ ${err.message || "Upload failed."}`, false);
                      } finally {
                        setSelectedFile(null);
                      }
                    } else if (autoSubmitPrompt) {
                      handleSubmit(undefined, `Upload ${file.name} as ${autoSubmitPrompt} for this case.`);
                      setAutoSubmitPrompt("");
                    }
                  }}
                  className="hidden"
                  accept=".pdf,.png,.jpg,.jpeg,.tiff,.bmp"
                />
                {/* Pill input with inline actions */}
                <div className="flex-1 flex items-center gap-0.5 bg-slate-100 rounded-full pl-1.5 pr-1 py-1 focus-within:ring-2 focus-within:ring-violet-400/50 transition-all">
                  <button type="button" onClick={() => fileInputRef.current?.click()} title="Attach Document"
                    className="p-2 text-slate-400 hover:text-violet-600 rounded-full transition-all shrink-0">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                  </button>
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={pendingInterrupt?.kind === "clarify" ? "Type your answer…" : "Message…"}
                    className="flex-1 bg-transparent text-slate-900 py-1.5 focus:outline-none text-[14px] placeholder:text-slate-400 min-w-0"
                  />
                  <button type="button" onClick={() => setShowVoice(true)} title="Live Voice Agent"
                    className="p-2 text-slate-400 hover:text-violet-600 rounded-full transition-all shrink-0">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 18v-6a9 9 0 0118 0v6M3 18a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3v5zm16 0a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3v5z" /></svg>
                  </button>
                  <button type="button" onMouseDown={startRecording} onMouseUp={stopRecording}
                    onMouseLeave={() => isRecording && stopRecording()} title="Hold to dictate"
                    className={`p-2 rounded-full transition-all shrink-0 ${isRecording ? "bg-rose-100 text-rose-600 animate-pulse" : "text-slate-400 hover:text-violet-600"}`}>
                    {isRecording
                      ? <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
                      : <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                    }
                  </button>
                </div>
                <button type="submit" disabled={!input.trim() || isLoading}
                  className="p-3 bg-gradient-to-br from-violet-500 to-fuchsia-500 hover:from-violet-600 hover:to-fuchsia-600 disabled:from-slate-300 disabled:to-slate-300 text-white rounded-full transition-all shadow-lg shadow-fuchsia-500/30 active:scale-90 shrink-0">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                </button>
              </form>
              {/* Recommended Next Steps — backend quick_actions are the source
                  of truth (each tool result ships context-aware suggestions);
                  the text heuristic only covers turns with no tool involved. */}
              <div className="flex items-center justify-center gap-1.5 mt-2 flex-wrap">
                {(turnActions.length > 0
                  ? turnActions
                  : getRecommendedActions(messages.length > 0 ? messages[messages.length - 1] : undefined)
                )
                  .slice(0, 3)
                  .map((action, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleQuickAction(action)}
                      className={`text-[10px] px-2.5 py-1 rounded-full font-medium transition-all border ${
                        action.actionType === "navigate"
                          ? "text-emerald-600 hover:text-white hover:bg-emerald-600 border-emerald-200"
                          : action.actionType === "upload"
                          ? "text-amber-600 hover:text-white hover:bg-amber-600 border-amber-200"
                          : action.actionType === "confirm"
                          ? "text-violet-600 hover:text-white hover:bg-violet-600 border-violet-200"
                          : "text-indigo-600 hover:text-white hover:bg-indigo-600 border-indigo-200"
                      }`}
                    >
                      {action.label}
                    </button>
                  ))}
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* ── Floating Suggestions Panel ─────────────────────────────────── */}
      {suggestedActions.length > 0 && !isLoading && (
        <div className="absolute bottom-[100px] right-full mr-6 w-[280px] z-50 animate-in slide-in-from-right-8 fade-in duration-500 pointer-events-auto">
          <div className="bg-white/95 backdrop-blur-xl rounded-2xl shadow-[0_15px_50px_-12px_rgba(0,0,0,0.15)] border border-slate-200 p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2 px-1">
              <span className="flex h-2.5 w-2.5 items-center justify-center rounded-full bg-emerald-100">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              </span>
              <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Suggested Next Actions</span>
            </div>
            <div className="flex flex-col gap-2">
              {suggestedActions.map((action, idx) => (
                <button
                  key={`${action}-${idx}`}
                  onClick={() => { setSuggestedActions([]); handleSubmit(undefined, action); }}
                  className="w-full text-left px-4 py-2.5 bg-slate-50 hover:bg-violet-50 text-slate-700 hover:text-violet-700 text-[13px] font-semibold rounded-xl border border-transparent hover:border-violet-100 transition-all active:scale-[0.98]"
                >
                  {action}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
