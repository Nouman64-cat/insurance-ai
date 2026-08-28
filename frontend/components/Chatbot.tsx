"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import VoiceOverlay from "./VoiceOverlay";
import { useRouter } from "next/navigation";
import { useNotify } from "./NotificationContext";
import { useAgentChat } from "@/lib/agent/useAgentChat";
import type { AgentMessage, QuickAction } from "@/lib/agent/types";
import { QuickActionSelect } from "./agent/QuickActionSelect";

const WELCOME: AgentMessage = {
  id: "1",
  role: "assistant",
  text: "Hello! I'm the **Insurance AI Agent**. I can help you navigate the platform or answer any insurance questions.\n\nChoose how you'd like to interact:",
};

const STORAGE_KEY = "chat_messages";

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
function IconRefresh() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
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
function IconBot({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8V4M8 4h.01" />
      <circle cx="9" cy="14" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="14" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

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
  const { notify } = useNotify();
  const { messages, send, resolveInterrupt, isLoading, pendingInterrupt, clearChat } = useAgentChat({
    storageKey: STORAGE_KEY,
    welcomeMessage: WELCOME,
  });

  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [showVoice, setShowVoice] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const handleNewChat = () => {
    if (window.confirm("Are you sure you want to start a new chat? This will clear your current history.")) {
      clearChat();
    }
  };

  // This surface has no document-attach affordance (unlike CopilotInterface),
  // so an agent-initiated upload_document call can never be fulfilled here —
  // resolve it immediately rather than leaving the conversation stuck waiting.
  useEffect(() => {
    if (pendingInterrupt?.kind === "client_execute") {
      resolveInterrupt({ success: false, error: "Document upload isn't supported in this chat window." });
    }
  }, [pendingInterrupt, resolveInterrupt]);

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

  const sendText = useCallback((text: string) => {
    if (!text.trim() || isLoading) return;
    if (pendingInterrupt?.kind === "clarify") {
      resolveInterrupt(text.trim());
    } else {
      send(text.trim());
    }
  }, [isLoading, pendingInterrupt, send, resolveInterrupt]);

  const handleQuickAction = useCallback((action: QuickAction) => {
    if (action.actionType === "navigate") {
      const path = action.payload.startsWith('/') ? action.payload : `/${action.payload}`;
      const sep = path.includes('?') ? '&' : '?';
      window.open(`${window.location.origin}${path}${sep}_portal=1`, "_blank");
    } else if (action.actionType === "confirm") {
      resolveInterrupt(action.payload === "Yes");
    } else if (action.actionType === "upload") {
      notify("Document upload isn't supported in this chat window — try the Copilot panel instead.", false);
    } else {
      sendText(action.payload);
    }
  }, [router, resolveInterrupt, sendText, notify]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = input;
    setInput("");
    sendText(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // ── Voice → Deepgram STT → Text ─────────────────────────────────────────
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
          if (transcript?.trim()) sendText(transcript);
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
    <>
      {/* ── FAB ────────────────────────────────────────────────────────────── */}
      <button
        onClick={() => setIsOpen(p => !p)}
        aria-label="Open AI Assistant"
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 text-white shadow-[0_8px_30px_rgba(99,102,241,0.45)] hover:shadow-[0_8px_36px_rgba(99,102,241,0.65)] hover:scale-105 active:scale-95 transition-all duration-200 flex items-center justify-center focus:outline-none focus:ring-4 focus:ring-blue-300/50"
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

          {showVoice && <VoiceOverlay onClose={() => setShowVoice(false)} />}

          {/* ── Header ──────────────────────────────────────────────────── */}
          <div className="bg-gradient-to-r from-blue-600 via-blue-600 to-blue-600 px-5 py-4 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-white/15 border border-white/30 flex items-center justify-center flex-shrink-0 text-white">
                <IconBot className="w-5 h-5" />
              </div>
              <div>
                <p className="text-white font-semibold text-sm leading-none">Insurance AI Agent</p>
                <p className="text-blue-200 text-[10px] uppercase tracking-widest mt-0.5 font-medium">Insurance Expert</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-blue-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
              <button onClick={handleNewChat} title="New Chat" className="ml-3 text-white/70 hover:text-white p-1.5 rounded-full hover:bg-white/10 transition-colors">
                <IconRefresh />
              </button>
              <button onClick={() => setIsOpen(false)} title="Close Chat" className="text-white/70 hover:text-white p-1.5 rounded-full hover:bg-white/10 transition-colors">
                <IconClose />
              </button>
            </div>
          </div>

          {/* ── Messages ────────────────────────────────────────────────── */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 bg-slate-50/60 scrollbar-thin scrollbar-thumb-slate-200 scrollbar-track-transparent">
            {messages.map((m) => (
              <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                {m.role === "assistant" && (
                  <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center mr-2 mt-1 flex-shrink-0 text-white">
                    <IconBot className="w-4 h-4" />
                  </div>
                )}
                <div className={`max-w-[78%] px-4 py-3 text-sm leading-relaxed rounded-2xl flex flex-col gap-2 ${m.role === "user" ? "bg-gradient-to-br from-blue-500 to-blue-600 text-white rounded-br-sm" : "bg-white text-slate-800 rounded-bl-sm shadow-sm ring-1 ring-slate-100"}`}>
                  {m.role === "user"
                    ? <p className="whitespace-pre-wrap">{m.text}</p>
                    : <div className="prose prose-sm prose-slate max-w-none prose-p:my-1 prose-ul:my-1 prose-li:my-0"><ReactMarkdown>{m.text}</ReactMarkdown></div>
                  }
                  {m.quickActions && m.quickActions.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {m.quickActions.map((action, idx) => action.actionType === "select" ? (
                        <QuickActionSelect
                          key={`select-${action.label}-${idx}`}
                          action={action}
                          onRun={sendText}
                        />
                      ) : (
                        <button
                          key={`${action.actionType}-${action.label}-${idx}`}
                          onClick={() => handleQuickAction(action)}
                          className="px-3 py-1 text-[11px] font-semibold rounded-full border bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-200 transition-all active:scale-95"
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
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
                className="flex-shrink-0 w-10 h-10 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-600 flex items-center justify-center transition-colors"
              >
                <IconHeadphones />
              </button>

              {/* Text input */}
              <div className={`flex-1 flex items-end gap-2 rounded-xl bg-slate-100 px-3 py-2 ring-1 ring-transparent focus-within:ring-blue-400 focus-within:bg-white transition-all duration-200 ${isRecording ? "opacity-50 pointer-events-none" : ""}`}>
                <textarea
                  ref={textareaRef}
                  value={isRecording ? "🎙 Listening…" : input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={pendingInterrupt?.kind === "clarify" ? "Type your answer…" : "Type a message…"}
                  rows={1}
                  className="flex-1 bg-transparent text-sm text-slate-800 resize-none focus:outline-none placeholder:text-slate-400 min-h-[24px] max-h-[100px] leading-relaxed"
                />
              </div>

              {/* Mic Button */}
              <button
                type="button"
                onClick={isRecording ? stopRecording : startRecording}
                title={isRecording ? "Stop recording" : "Speak (voice-to-text)"}
                className={`flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-200 ${isRecording ? "bg-rose-500 text-white shadow-[0_0_12px_rgba(244,63,94,0.4)] animate-pulse" : "bg-slate-100 hover:bg-slate-200 text-slate-600"}`}
              >
                <IconMic active={isRecording} />
              </button>

              {/* Send Button */}
              <button
                type="submit"
                disabled={!input.trim() || isLoading}
                className="flex-shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 text-white flex items-center justify-center disabled:opacity-40 hover:opacity-90 active:scale-95 transition-all duration-150 shadow-md shadow-blue-500/20"
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
                <span className="text-blue-400">⌨</span> Text → Gemini
              </span>
              <span className="text-[10px] text-slate-400 flex items-center gap-1">
                <span className="text-rose-400">🎙</span> Voice → Text
              </span>
              <span className="text-[10px] text-slate-400 flex items-center gap-1">
                <span className="text-blue-400">🎧</span> Live Agent
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
