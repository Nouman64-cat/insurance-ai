"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import api from "../app/services/api";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ALL_TOOLS } from "../lib/agent/tools";
import { useNotify } from "./NotificationContext";

const SYSTEM_PROMPT = `Your name is Insurance AI Agent, a helpful, expert AI voice assistant for the "insurance-ai" platform — an AI-powered insurance underwriting system. Keep responses brief and conversational since this is a voice interface. Cover: Underwriting (risk scores, OCR, AI recommendations), Live Evaluation, Score Engine, Organizations, Fraud Detection, Claims. Expert in: premiums, sum assured, riders, BMI underwriting, reinsurance, Term/Whole/Endowment/Group Life. Be warm, concise, professional.

CRITICAL INSTRUCTION: You have access to system tools (functions) to perform real actions. You MUST use these tools when a user asks you to:
1. Navigate to a page (use navigate_to_page)
2. Add a new applicant (use add_applicant)
3. Delete an applicant (use delete_applicant)
4. Get details about a case or applicant (use get_case_details)
5. Run an underwriting risk assessment (use run_risk_assessment)

DO NOT hallucinate or pretend to perform these actions, and DO NOT invent missing required information (a CNIC, a Date of Birth, an email) yourself. If you need more information to execute a tool, ask the user for it first — out loud, since this is a voice call — and only call the function once you actually have it. Never just say you did something without calling the function.

Before performing anything that creates, changes, or deletes data, briefly confirm with the user out loud that you're about to do it (e.g. "Adding customer John Doe now — is that right?") and only call the function after they agree.`;

type Status = "connecting" | "listening" | "speaking" | "error";

interface Caption { role: "user" | "agent"; text: string; }

interface Props { onClose: () => void; }

export default function VoiceOverlay({ onClose }: Props) {
  const router = useRouter();
  const { notify } = useNotify();
  const [status, setStatus] = useState<Status>("connecting");
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [elapsed, setElapsed] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const inCtxRef = useRef<AudioContext | null>(null);
  const outCtxRef = useRef<AudioContext | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextTimeRef = useRef(0);
  const captionEndRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    captionEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [captions]);

  useEffect(() => {
    timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const clearAudio = (ctx?: AudioContext | null) => {
    sourcesRef.current.forEach(s => { try { s.stop(); } catch (_) { } });
    sourcesRef.current = [];
    if (ctx) nextTimeRef.current = ctx.currentTime;
  };

  const teardown = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    clearAudio(outCtxRef.current);
    procRef.current?.disconnect();
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.close(1000);
    wsRef.current = null;
    if (inCtxRef.current) { inCtxRef.current.close().catch(() => { }); inCtxRef.current = null; }
    if (outCtxRef.current) { outCtxRef.current.close().catch(() => { }); outCtxRef.current = null; }
    if (micRef.current) { micRef.current.getTracks().forEach(t => t.stop()); micRef.current = null; }
  };

  const handleEnd = () => { teardown(); onClose(); };

  useEffect(() => {
    let mounted = true;
    const init = async () => {
      try {
        const r = await fetch("/api/agent-config");
        if (!mounted) return;
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || "Live voice is not configured.");
        }
        const { deepgramApiKey } = await r.json();
        if (!mounted) return;

        // Auth via subprotocol for browser WebSockets
        const ws = new WebSocket(
          `wss://agent.deepgram.com/v1/agent/converse`,
          ['token', deepgramApiKey]
        );
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;

        ws.onopen = () => {
          if (!mounted) {
            ws.close();
            return;
          }
          // Don't send anything yet — wait for Welcome message
          console.log("[DG Agent] WS opened, waiting for Welcome…");
        };

        ws.onmessage = async (ev) => {
          if (!mounted) return;
          // ── Binary: PCM audio from agent ──────────────────────────────
          if (ev.data instanceof ArrayBuffer) {
            const ctx = outCtxRef.current;
            if (!ctx || ev.data.byteLength === 0) return;
            const pcm = new Int16Array(ev.data);
            const f32 = new Float32Array(pcm.length);
            for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
            const ab = ctx.createBuffer(1, f32.length, 24000);
            ab.copyToChannel(f32, 0);
            const src = ctx.createBufferSource();
            src.buffer = ab;
            src.connect(ctx.destination);
            const now = ctx.currentTime;
            const at = Math.max(now, nextTimeRef.current);
            sourcesRef.current.push(src);
            src.start(at);
            nextTimeRef.current = at + ab.duration;
            src.onended = () => {
              if (!mounted) return;
              sourcesRef.current = sourcesRef.current.filter(s => s !== src);
              if (!sourcesRef.current.length) setStatus("listening");
            };
            return;
          }

          // ── Text: control/event messages ──────────────────────────────
          if (typeof ev.data !== "string") return;
          let msg: any;
          try { msg = JSON.parse(ev.data); } catch { return; }
          console.log("[DG Agent]", msg.type, msg);

          switch (msg.type) {
            case "Welcome":
              // NOW send Settings after receiving Welcome
              ws.send(JSON.stringify({
                type: "Settings",
                audio: {
                  input: { encoding: "linear16", sample_rate: 16000 },
                  output: { encoding: "linear16", sample_rate: 24000, container: "none" },
                },
                agent: {
                  listen: { provider: { type: "deepgram", model: "nova-2" } },
                  think: {
                    provider: {
                      type: "open_ai",
                      model: "gpt-4o-mini"
                    },
                    prompt: SYSTEM_PROMPT,
                    functions: ALL_TOOLS.map(t => {
                      const s = (t.schema as any).toJSONSchema ? (t.schema as any).toJSONSchema() : zodToJsonSchema(t.schema);
                      const { $schema, ...params } = s;
                      return {
                        name: t.name,
                        description: t.description,
                        parameters: params
                      };
                    })
                  },
                  speak: { provider: { type: "deepgram", model: "aura-asteria-en" } },
                },
              }));
              break;

            case "SettingsApplied":
              // Settings accepted — now set up mic and audio output
              try {
                const outCtx = new AudioContext({ sampleRate: 24000 });
                outCtxRef.current = outCtx;
                nextTimeRef.current = 0;

                const stream = await navigator.mediaDevices.getUserMedia({
                  audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                });
                if (!mounted) {
                  stream.getTracks().forEach(t => t.stop());
                  return;
                }
                micRef.current = stream;
                const inCtx = new AudioContext({ sampleRate: 16000 });
                inCtxRef.current = inCtx;
                const src = inCtx.createMediaStreamSource(stream);
                const proc = inCtx.createScriptProcessor(4096, 1, 1);
                procRef.current = proc;
                proc.onaudioprocess = (e) => {
                  if (!mounted || ws.readyState !== WebSocket.OPEN) return;
                  const raw = e.inputBuffer.getChannelData(0);
                  const pcm = new Int16Array(raw.length);
                  for (let i = 0; i < raw.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, raw[i] * 32768));
                  ws.send(pcm.buffer);
                };
                src.connect(proc);
                proc.connect(inCtx.destination);
                setStatus("listening");
              } catch (micErr: any) {
                if (!mounted) return;
                setErrorMsg("Microphone access denied. Please allow microphone in browser settings.");
                setStatus("error");
              }
              break;

            case "UserStartedSpeaking":
              clearAudio(outCtxRef.current);
              setStatus("listening");
              break;

            case "AgentSpeakingStarted":
              setStatus("speaking");
              break;

            case "AgentSpeakingStopped":
              // Audio may still be playing; onended will set listening
              break;

            case "ConversationText":
              if (msg.role === "user") {
                setCaptions(p => [...p, { role: "user", text: msg.content }]);
              } else if (msg.role === "agent" || msg.role === "assistant") {
                setCaptions(p => [...p, { role: "agent", text: msg.content }]);
              }
              break;

            case "FunctionCallRequest":
              console.log("Deepgram FunctionCallRequest:", msg);
              handleFunctionCall(msg, ws, router);
              break;

            case "Error":
              setErrorMsg(msg.message || "Agent error");
              setStatus("error");
              break;

            default: break;
          }
        };

        ws.onerror = () => {
          if (!mounted) return;
          setErrorMsg("WebSocket connection failed. Please check your network.");
          setStatus("error");
        };

        ws.onclose = (ev) => {
          if (!mounted) return;
          console.log("[DG Agent] closed", ev.code, ev.reason);
          if (ev.code !== 1000 && ev.code !== 1005) {
            setErrorMsg(`Connection closed (${ev.code})${ev.reason ? ": " + ev.reason : ""}`);
            setStatus("error");
          }
        };

      } catch (err: any) {
        if (!mounted) return;
        setErrorMsg(err?.message || "Initialization failed");
        setStatus("error");
      }
    };

    init();
    return () => {
      mounted = false;
      teardown();
    };
  }, []);

  // Every REST call a tool makes now lives in exactly one place —
  // services/chat-agent/tool_executor.py, reused here via the non-streaming
  // /chat/execute-tool endpoint instead of a third copy of the same REST
  // logic. Deepgram's hosted agent drives its own tool-call decisions and
  // expects a synchronous response, so this can't join the interrupt/resume
  // protocol the text/copilot surfaces use — but it still gets the same
  // RBAC hard block (role is checked server-side) and the same
  // action-completed toast/navigate wiring.
  const handleFunctionCall = async (msg: any, ws: WebSocket, router: any) => {
    if (!msg.functions || !Array.isArray(msg.functions)) return;

    for (const fn of msg.functions) {
      const { id, name, arguments: argsString } = fn;
      let args: any = {};
      try { args = typeof argsString === "string" ? JSON.parse(argsString) : argsString; } catch { }

      console.log(`Executing tool: ${name}`, args);

      let result: any;
      if (name === "navigate_to_page") {
        router.push(`/${args.page_name === "dashboard" ? "" : args.page_name}`);
        result = { success: true, message: `Navigating to ${args.page_name}` };
      } else if (name === "upload_document") {
        // No attach-a-file affordance on this surface either.
        result = { success: false, error: "Document upload isn't supported over voice — try the Copilot panel instead." };
      } else {
        const role = localStorage.getItem("user_role") || "Agent";
        try {
          const res = await api.post("/chat/execute-tool", { name, args, role });
          result = res.data;
        } catch (e: any) {
          result = { success: false, error: e.response?.data?.detail || e.message || "Failed to execute function." };
        }
      }

      if (result?.last_action) {
        notify(`✅ ${result.last_action.label}`, true, result.last_action.route);
      } else if (result?.success === false) {
        notify(`⚠️ ${result.error || result.message || "Action failed."}`, false);
      }

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "FunctionCallResponse",
          id: id,
          name: name,
          content: JSON.stringify(result)
        }));
      }
    }
  };

  // ── Plasma Orb ─────────────────────────────────────────────────────────────
  const colors = {
    listening: {
      core: "from-blue-400 via-blue-500 to-blue-600",
      glow: "rgba(99,102,241,0.5)",
      ring1: "border-blue-400/30",
      ring2: "border-blue-400/20",
      ring3: "border-blue-400/10",
    },
    speaking: {
      core: "from-blue-500 via-fuchsia-500 to-pink-500",
      glow: "rgba(217,70,239,0.6)",
      ring1: "border-blue-400/40",
      ring2: "border-fuchsia-400/30",
      ring3: "border-pink-400/20",
    },
  };

  const isActive = status === "listening" || status === "speaking";
  const c = status === "speaking" ? colors.speaking : colors.listening;

  return (
    <div className="absolute inset-0 z-50 flex flex-col overflow-hidden rounded-[1.75rem]"
      style={{ background: "radial-gradient(ellipse at 50% 30%, #1a0a2e 0%, #0d0d1a 60%, #080810 100%)" }}>

      {/* ── Ambient background glow ──────────────────────────────────────────── */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-[1.75rem]">
        <div className={`absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-72 h-72 rounded-full blur-[80px] opacity-25 transition-all duration-1000 ${status === "speaking" ? "bg-fuchsia-600 scale-125" : "bg-blue-700 scale-100"}`} />
        <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-48 rounded-full blur-[60px] opacity-20 transition-all duration-700 ${status === "speaking" ? "bg-blue-500" : "bg-blue-700"}`} />
      </div>

      {/* ── Top bar ──────────────────────────────────────────────────────────── */}
      <div className="relative z-10 flex items-center justify-between px-5 pt-5 pb-1">
        <div className="flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full ${status === "error" ? "bg-rose-400" : status === "connecting" ? "bg-amber-400 animate-pulse" : "bg-blue-400 animate-pulse shadow-[0_0_6px_rgba(52,211,153,0.9)]"}`} />
          <span className="text-white/50 text-[10px] font-semibold uppercase tracking-[0.18em]">
            {status === "connecting" ? "Initializing" : status === "error" ? "Failed" : `Live · ${fmt(elapsed)}`}
          </span>
        </div>
        <button onClick={handleEnd} className="text-white/30 hover:text-white/70 transition-colors p-1.5 rounded-full hover:bg-white/10">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* ── Plasma Orb ───────────────────────────────────────────────────────── */}
      <div className="relative z-10 flex flex-col items-center justify-center pt-2 pb-1 gap-3">
        <div className="relative w-56 h-56 flex items-center justify-center">

          {/* Connecting spinner */}
          {status === "connecting" && (
            <div className="absolute inset-0 flex items-center justify-center">
              {/* Outer plasma ring */}
              <div className="absolute inset-[-20px] rounded-full border-[3px] border-blue-400/20 border-t-blue-400/80 animate-[spin_3s_linear_infinite]" />
              <div className="absolute inset-0 rounded-full border-[2px] border-blue-400/10 border-b-fuchsia-400/60 animate-[spin_2s_linear_infinite_reverse]" />
              <div className="absolute inset-[20px] rounded-full border border-blue-400/10 border-l-blue-300/50 animate-[spin_1.5s_linear_infinite]" />
              {/* Core glow */}
              <div className="absolute inset-[30px] rounded-full bg-blue-500/20 blur-2xl animate-pulse" />
              <div className="w-48 h-48 rounded-full shadow-[0_0_40px_rgba(255,255,255,0.1)] overflow-hidden border-2 border-blue-500/30 bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center">
                <svg className="w-24 h-24 text-white/90" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <rect x="4" y="8" width="16" height="12" rx="2" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8V4M8 4h.01" />
                  <circle cx="9" cy="14" r="1" fill="currentColor" stroke="none" />
                  <circle cx="15" cy="14" r="1" fill="currentColor" stroke="none" />
                </svg>
              </div>
            </div>
          )}

          {/* Active: Plasma rings */}
          {isActive && (
            <>
              {/* Complex interacting plasma waves */}
              <div className={`absolute inset-[-40px] rounded-full border ${c.ring3} animate-[ping_4s_cubic-bezier(0.1,0,0.2,1)_infinite]`} />
              <div className={`absolute inset-[-20px] rounded-full border ${c.ring2} animate-[ping_3s_cubic-bezier(0.1,0,0.2,1)_infinite]`} style={{ animationDelay: "0.8s" }} />
              <div className={`absolute inset-[-5px] rounded-full border ${c.ring1} animate-[ping_2s_cubic-bezier(0.1,0,0.2,1)_infinite]`} style={{ animationDelay: "0.4s" }} />

              {/* Deep plasma glow halo */}
              <div className={`absolute inset-[-10px] rounded-full bg-gradient-to-br ${c.core} blur-3xl opacity-40 transition-all duration-1000 mix-blend-screen`}
                style={{ transform: status === "speaking" ? "scale(1.5) rotate(45deg)" : "scale(1) rotate(0deg)" }} />

              {/* Core orb - Glassmorphic sphere */}
              <div className={`relative w-64 h-64 rounded-full flex items-center justify-center transition-all duration-700 overflow-hidden border-[3px] border-white/10`}
                style={{
                  boxShadow: `0 0 100px ${c.glow}, inset 0 0 50px rgba(0,0,0,0.5)`,
                  transform: status === "speaking" ? "scale(1.1)" : "scale(1)",
                }}>

                {/* Agent Avatar (icon-based, no photo) */}
                <div className="absolute inset-0 rounded-full overflow-hidden z-0 bg-gradient-to-br from-blue-500 via-blue-600 to-fuchsia-600 flex items-center justify-center">
                  <svg className={`w-32 h-32 text-white/90 transition-transform duration-500 ${status === "speaking" ? "scale-110" : "scale-100"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <rect x="4" y="8" width="16" height="12" rx="2" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8V4M8 4h.01" />
                    <circle cx="9" cy="14" r="1" fill="currentColor" stroke="none" />
                    <circle cx="15" cy="14" r="1" fill="currentColor" stroke="none" />
                  </svg>
                </div>

                {/* Subtle gradient overlay to blend image with plasma */}
                <div className={`absolute inset-0 bg-gradient-to-br ${c.core} mix-blend-overlay opacity-30 z-0`} />

                {/* Sphere reflections */}
                <div className="absolute top-2 left-6 w-24 h-12 bg-white/40 rounded-[100%] blur-[3px] transform -rotate-12 z-10" />
                <div className="absolute bottom-4 right-8 w-16 h-8 bg-white/20 rounded-[100%] blur-[4px] transform rotate-12 z-10" />

                {/* Speaking audio reactive bars */}
                {status === "speaking" && (
                  <div className="flex items-center gap-[4px] h-12 z-10">
                    {[18, 30, 42, 28, 20, 36, 16].map((h, i) => (
                      <div key={i} className="w-[4px] bg-white rounded-full animate-[bounce_0.6s_ease-in-out_infinite] shadow-[0_0_10px_rgba(255,255,255,0.8)]"
                        style={{ height: `${h}px`, animationDelay: `${i * 90}ms` }} />
                    ))}
                  </div>
                )}

                {/* Listening: elegant mic icon */}
                {status === "listening" && (
                  <div className="flex flex-col items-center gap-1 z-10 animate-[pulse_2s_ease-in-out_infinite]">
                    <svg className="w-12 h-12 text-white filter drop-shadow-[0_0_8px_rgba(255,255,255,0.6)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Error state - Muted glass instead of harsh red */}
          {status === "error" && (
            <div className="w-36 h-36 rounded-full bg-black/40 backdrop-blur-xl border border-rose-500/30 flex items-center justify-center shadow-[0_0_50px_rgba(225,29,72,0.15)] relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-rose-500/10 to-transparent" />
              <div className="absolute top-2 left-6 w-16 h-8 bg-white/10 rounded-[100%] blur-[2px] transform -rotate-12" />
              <svg className="w-12 h-12 text-rose-400/80 relative z-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
          )}
        </div>

        {/* Status label */}
        <div className="text-center min-h-[40px] flex flex-col items-center justify-center gap-1">
          <p className={`text-[13px] font-medium tracking-wide transition-all duration-500 ${status === "speaking" ? "text-fuchsia-200 drop-shadow-[0_0_8px_rgba(217,70,239,0.5)]" :
            status === "listening" ? "text-blue-200 drop-shadow-[0_0_8px_rgba(34,211,238,0.5)]" :
              status === "connecting" ? "text-blue-200/80 animate-pulse" : "text-rose-300/80"
            }`}>
            {status === "connecting" && "Connecting to AI Agent…"}
            {status === "listening" && "Listening — go ahead and speak"}
            {status === "speaking" && "Speaking…"}
            {status === "error" && "Connection Failed"}
          </p>
          {status === "error" && errorMsg && (
            <p className="text-rose-500/60 text-[11px] max-w-[260px] text-center leading-snug">{errorMsg}</p>
          )}
        </div>
      </div>

      {/* ── Captions ─────────────────────────────────────────────────────────── */}
      <div className="relative z-10 flex-1 mx-4 mb-3 overflow-hidden rounded-xl"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
        <div className="absolute inset-0 overflow-y-auto px-3 py-3 space-y-2 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
          {captions.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-white/20 text-xs text-center">Transcript will appear here as you speak</p>
            </div>
          ) : (
            captions.map((c, i) => (
              <div key={i} className={`flex ${c.role === "user" ? "justify-end" : "justify-start"} animate-in fade-in slide-in-from-bottom-1 duration-200`}>
                <div className={`max-w-[90%] px-3 py-2 rounded-xl text-[12px] leading-relaxed ${c.role === "user"
                  ? "text-blue-50 rounded-br-sm"
                  : "text-fuchsia-50 rounded-bl-sm"
                  }`}
                  style={c.role === "user"
                    ? { background: "rgba(99,102,241,0.2)", border: "1px solid rgba(99,102,241,0.25)" }
                    : { background: "rgba(168,85,247,0.2)", border: "1px solid rgba(168,85,247,0.25)" }
                  }>
                  <span className={`block text-[9px] uppercase font-bold tracking-widest mb-1 ${c.role === "user" ? "text-blue-400/70" : "text-fuchsia-400/70"}`}>
                    {c.role === "user" ? "You" : "Insurance AI Agent"}
                  </span>
                  {c.text}
                </div>
              </div>
            ))
          )}
          <div ref={captionEndRef} />
        </div>
      </div>

      {/* ── End Call ─────────────────────────────────────────────────────────── */}
      <div className="relative z-10 flex flex-col items-center pb-8 gap-2">
        <button
          onClick={handleEnd}
          className="w-16 h-16 rounded-full flex items-center justify-center transition-all duration-300 hover:scale-105 active:scale-95 group relative overflow-hidden"
          style={{
            background: "rgba(255,255,255,0.05)",
            backdropFilter: "blur(12px)",
            border: "1px solid rgba(255,255,255,0.1)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.3)"
          }}
          title="End call"
        >
          {/* Subtle red hover glow instead of solid red button */}
          <div className="absolute inset-0 bg-rose-500/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300 blur-xl" />
          <div className="absolute inset-0 bg-gradient-to-b from-white/10 to-transparent" />

          <svg className="w-7 h-7 text-white/80 group-hover:text-rose-400 transition-colors relative z-10" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6.62 10.79a15.53 15.53 0 006.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C10.61 21 3 13.39 3 4c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.24 1.02l-2.21 2.2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
