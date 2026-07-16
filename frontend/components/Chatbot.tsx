"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import VoiceOverlay from "./VoiceOverlay";
import { useRouter } from "next/navigation";
import api from "../app/services/api";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Message {
  role: "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

// ─── Constants ────────────────────────────────────────────────────────────────
const WELCOME: Message = {
  role: "assistant",
  content: "Hello! I'm **Sara**, your AI Insurance Assistant. I can help you navigate the platform or answer any insurance questions.\n\nChoose how you'd like to interact:",
};

// ─── Icons ───────────────────────────────────────────────────────────────────
function IconSend() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
    </svg>
  );
}
function IconMic({ active }: { active?: boolean }) {
  return active ? (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
  ) : (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
    </svg>
  );
}
function IconHeadphones() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 18v-6a9 9 0 0118 0v6M3 18a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3v5zm16 0a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3v5z" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
function IconChat() {
  return (
    <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
    </svg>
  );
}

// ─── Typing Indicator ────────────────────────────────────────────────────────
function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-1.5 bg-white rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm ring-1 ring-slate-100">
        {[0, 1, 2].map(i => (
          <div key={i} className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
        ))}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export function Chatbot() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [showVoice, setShowVoice] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // ── Tool Execution Helper ──────────────────────────────────────────────────
  const executeLocalTool = async (name: string, argsString: string) => {
    let args: any = {};
    try { args = typeof argsString === "string" ? JSON.parse(argsString) : argsString; } catch {}
    
    let result: any = { success: false, message: "Unknown function" };
    const tenantId = localStorage.getItem("tenant_id") || "00000000-0000-0000-0000-000000000001";
    console.log(`[Chatbot] Executing tool: ${name}`, args);

    try {
      if (name === "navigate_to_page") {
        router.push(`/${args.page_name === "dashboard" ? "" : args.page_name}`);
        result = { success: true, message: `Navigating to ${args.page_name}` };
      } 
      else if (name === "add_applicant") {
        const res = await api.post(`/tenants/${tenantId}/applicants`, {
           first_name: args.first_name,
           last_name: args.last_name,
           cnic: args.cnic,
           date_of_birth: args.date_of_birth,
           gender: args.gender,
           occupation: args.occupation,
           declared_income: args.declared_income,
           is_smoker: false,
           height_cm: 170,
           weight_kg: 70,
           details: {}
        });
        result = { success: true, applicant_id: res.data.id, message: "Applicant added successfully." };
      }
      else if (name === "delete_applicant") {
        const list = await api.get(`/tenants/${tenantId}/applicants`);
        const app = list.data.find((a: any) => 
          (args.cnic && a.cnic === args.cnic) || 
          (args.name && a.name.toLowerCase().includes(args.name.toLowerCase()))
        );
        if (!app) throw new Error("Applicant not found");
        await api.delete(`/tenants/${tenantId}/applicants/${app.id}`);
        result = { success: true, message: `Applicant ${app.name} deleted.` };
      }
      else if (name === "get_case_details") {
        const list = await api.get(`/tenants/${tenantId}/cases`);
        const c = list.data.find((c: any) => 
          (args.case_number && c.caseNumber === args.case_number) || 
          (args.applicant_name && c.applicant_name?.toLowerCase().includes(args.applicant_name.toLowerCase()))
        );
        if (!c) throw new Error("Case not found");
        result = { 
          success: true, 
          case_number: c.caseNumber, 
          status: c.caseStatus, 
          applicant: c.applicant_name,
          ai_decision: c.latest_ai_decision || "Pending",
          product: c.product_name
        };
      }
      else if (name === "run_risk_assessment") {
        const list = await api.get(`/tenants/${tenantId}/cases`);
        const c = list.data.find((c: any) => 
          (args.case_number && c.caseNumber === args.case_number) || 
          (args.applicant_name && c.applicant_name?.toLowerCase().includes(args.applicant_name.toLowerCase()))
        );
        if (!c) throw new Error("Case not found");
        
        const detailRes = await api.get(`/tenants/${tenantId}/cases/${c.caseld}/detail`);
        const { applicant, policy } = detailRes.data;
        if (!applicant || !policy) throw new Error("Missing applicant or policy details to run assessment.");
        
        await api.post(`/evaluate`, { applicant, policy, case_id: c.caseld });
        result = { success: true, message: "Underwriting evaluation triggered in the background. It will be ready in a few moments." };
      }
    } catch (e: any) {
      console.error(`[Chatbot] Tool execution error [${name}]:`, e);
      result = { success: false, error: e.response?.data?.detail || e.message || "Failed to execute function." };
    }
    return JSON.stringify(result);
  };

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + "px";
    }
  }, [input]);

  // ── Scenario 1 & 2 Core Chat Loop ──────────────────────────────────────────
  const sendText = useCallback(async (text: string) => {
    if (!text.trim() || isLoading) return;
    const userMsg: Message = { role: "user", content: text.trim() };
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);

    let currentMessages = [...messages, userMsg];

    try {
      while (true) {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: currentMessages }),
        });
        if (!res.ok) throw new Error("Chat API failed");
        const data = await res.json();
        
        const assistantMsg: Message = { 
          role: "assistant", 
          content: data.message, 
          tool_calls: data.tool_calls 
        };
        currentMessages = [...currentMessages, assistantMsg];
        setMessages(currentMessages);

        // If no tools were called, the loop is finished.
        if (!data.tool_calls || data.tool_calls.length === 0) {
          break;
        }

        // Execute tools
        for (const tc of data.tool_calls) {
          const resultStr = await executeLocalTool(tc.function.name, tc.function.arguments);
          const toolMsg: Message = {
            role: "tool",
            tool_call_id: tc.id,
            name: tc.function.name,
            content: resultStr
          };
          currentMessages = [...currentMessages, toolMsg];
        }
        setMessages(currentMessages);
      }
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "⚠️ Error connecting to the server. Please try again." }]);
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, messages]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    sendText(input);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendText(input);
    }
  };

  // ── Scenario 2: Voice → Deepgram STT → Groq → Text ─────────────────────────
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
        setIsLoading(true);
        try {
          const fd = new FormData();
          fd.append("audio", blob, "recording.webm");
          const sttRes = await fetch("/api/stt", { method: "POST", body: fd });
          if (!sttRes.ok) throw new Error("STT failed");
          const { transcript } = await sttRes.json();
          if (transcript?.trim()) {
            await sendText(transcript);
          } else {
            setIsLoading(false);
          }
        } catch {
          setMessages(prev => [...prev, { role: "assistant", content: "⚠️ Could not transcribe audio. Please try again." }]);
          setIsLoading(false);
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
    <>
      {/* ── FAB ────────────────────────────────────────────────────────────── */}
      <button
        onClick={() => setIsOpen(p => !p)}
        aria-label="Open AI Assistant"
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-[0_8px_30px_rgba(99,102,241,0.45)] hover:shadow-[0_8px_36px_rgba(99,102,241,0.65)] hover:scale-105 active:scale-95 transition-all duration-200 flex items-center justify-center focus:outline-none focus:ring-4 focus:ring-indigo-300/50"
      >
        {isOpen ? <IconClose /> : (
          <div className="relative">
            <IconChat />
            <span className="absolute -top-1 -right-1 flex h-3 w-3">
              <span className="animate-ping absolute inset-0 rounded-full bg-white opacity-60" />
              <span className="relative rounded-full h-3 w-3 bg-white" />
            </span>
          </div>
        )}
      </button>

      {/* ── Chat Window ────────────────────────────────────────────────────── */}
      {isOpen && (
        <div className="fixed bottom-24 right-6 z-50 w-[360px] sm:w-[400px] h-[580px] max-h-[82vh] rounded-[1.75rem] shadow-[0_24px_64px_rgba(0,0,0,0.18)] border border-slate-200/60 flex flex-col overflow-hidden bg-white animate-in fade-in zoom-in-95 slide-in-from-bottom-4 duration-200 origin-bottom-right">
          
          {/* Voice Overlay (Scenario 3) rendered inside the window */}
          {showVoice && <VoiceOverlay onClose={() => setShowVoice(false)} />}

          {/* ── Header ──────────────────────────────────────────────────── */}
          <div className="bg-gradient-to-r from-indigo-600 via-purple-600 to-violet-600 px-5 py-4 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl overflow-hidden border border-white/30 flex-shrink-0">
                <img src="https://raw.githubusercontent.com/Zynaly/City-surveillance-Agent-Twilio-Deepgram-/main/static/roboi.jpg" alt="Sara" className="w-full h-full object-cover" />
              </div>
              <div>
                <p className="text-white font-semibold text-sm leading-none">Sara</p>
                <p className="text-indigo-200 text-[10px] uppercase tracking-widest mt-0.5 font-medium">Insurance Expert</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
              <button onClick={() => setIsOpen(false)} className="ml-2 text-white/70 hover:text-white p-1.5 rounded-full hover:bg-white/10 transition-colors">
                <IconClose />
              </button>
            </div>
          </div>

          {/* ── Messages ────────────────────────────────────────────────── */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 bg-slate-50/60 scrollbar-thin scrollbar-thumb-slate-200 scrollbar-track-transparent">
            {messages.map((m, i) => {
              if (m.role === "tool" || (m.role === "assistant" && !m.content)) return null;
              return (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  {m.role === "assistant" && (
                    <div className="w-7 h-7 rounded-full overflow-hidden mr-2 mt-1 flex-shrink-0">
                      <img src="https://raw.githubusercontent.com/Zynaly/City-surveillance-Agent-Twilio-Deepgram-/main/static/roboi.jpg" alt="Sara" className="w-full h-full object-cover" />
                    </div>
                  )}
                  <div className={`max-w-[78%] px-4 py-3 text-sm leading-relaxed rounded-2xl ${m.role === "user" ? "bg-gradient-to-br from-indigo-500 to-violet-600 text-white rounded-br-sm" : "bg-white text-slate-800 rounded-bl-sm shadow-sm ring-1 ring-slate-100"}`}>
                    {m.role === "user"
                      ? <p className="whitespace-pre-wrap">{m.content}</p>
                      : <div className="prose prose-sm prose-slate max-w-none prose-p:my-1 prose-ul:my-1 prose-li:my-0"><ReactMarkdown>{m.content || ""}</ReactMarkdown></div>
                    }
                  </div>
                </div>
              );
            })}
            {isLoading && <TypingIndicator />}
            <div ref={bottomRef} />
          </div>

          {/* ── Input Bar ───────────────────────────────────────────────── */}
          <div className="px-3 py-3 bg-white border-t border-slate-100 flex-shrink-0">
            <form onSubmit={handleSubmit} className="flex items-end gap-2">
              
              {/* Live Voice Button */}
              <button
                type="button"
                onClick={() => setShowVoice(true)}
                title="Start live voice conversation"
                className="flex-shrink-0 w-10 h-10 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-600 flex items-center justify-center transition-colors"
              >
                <IconHeadphones />
              </button>

              {/* Text input */}
              <div className={`flex-1 flex items-end gap-2 rounded-xl bg-slate-100 px-3 py-2 ring-1 ring-transparent focus-within:ring-indigo-400 focus-within:bg-white transition-all duration-200 ${isRecording ? "opacity-50 pointer-events-none" : ""}`}>
                <textarea
                  ref={textareaRef}
                  value={isRecording ? "🎙 Listening…" : input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type a message…"
                  rows={1}
                  className="flex-1 bg-transparent text-sm text-slate-800 resize-none focus:outline-none placeholder:text-slate-400 min-h-[24px] max-h-[100px] leading-relaxed"
                />
              </div>

              {/* Mic Button (Scenario 2) */}
              <button
                type="button"
                onClick={isRecording ? stopRecording : startRecording}
                title={isRecording ? "Stop recording" : "Speak (voice-to-text)"}
                className={`flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-200 ${isRecording ? "bg-rose-500 text-white shadow-[0_0_12px_rgba(244,63,94,0.4)] animate-pulse" : "bg-slate-100 hover:bg-slate-200 text-slate-600"}`}
              >
                <IconMic active={isRecording} />
              </button>

              {/* Send Button (Scenario 1) */}
              <button
                type="submit"
                disabled={!input.trim() || isLoading}
                className="flex-shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center disabled:opacity-40 hover:opacity-90 active:scale-95 transition-all duration-150 shadow-md shadow-indigo-500/20"
              >
                {isLoading ? (
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="white" strokeWidth="4" />
                    <path className="opacity-75" fill="white" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : <IconSend />}
              </button>
            </form>

            {/* Legend */}
            <div className="flex justify-center gap-4 mt-2 pb-0.5">
              <span className="text-[10px] text-slate-400 flex items-center gap-1">
                <span className="text-indigo-400">⌨</span> Text → Groq
              </span>
              <span className="text-[10px] text-slate-400 flex items-center gap-1">
                <span className="text-rose-400">🎙</span> Voice → Text
              </span>
              <span className="text-[10px] text-slate-400 flex items-center gap-1">
                <span className="text-violet-400">🎧</span> Live Agent
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
