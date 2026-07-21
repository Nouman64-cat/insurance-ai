"use client";

import React, { useState, useRef, useEffect } from "react";
import VoiceOverlay from "./VoiceOverlay";
import { ALL_TOOLS } from "@/lib/agent/tools";
import { useRouter } from "next/navigation";

interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  toolCall?: {
    id?: string;
    name: string;
    params: any;
    status: "pending" | "executed";
  };
  actionLink?: string;
  actionLabel?: string;
  quickActionText?: string;
  quickActionLabel?: string;
}

const LOCAL_STORAGE_HISTORY_KEY = "copilot_history";

export function CopilotInterface() {
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const hist = localStorage.getItem(LOCAL_STORAGE_HISTORY_KEY);
      if (hist) return JSON.parse(hist);
    } catch {}
    return [
      {
        id: "1",
        role: "agent",
        text: "Hello! I am your AI Underwriting Copilot. I can help you onboard applicants, run risk assessments, or pull case details instantly. What would you like to automate today?"
      }
    ];
  });
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [autoSubmitPrompt, setAutoSubmitPrompt] = useState("");
  const [suggestedActions, setSuggestedActions] = useState<string[]>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem(LOCAL_STORAGE_HISTORY_KEY + "_suggestions");
        if (saved) return JSON.parse(saved);
      } catch {}
    }
    return [];
  });
  const [suggestionRationale, setSuggestionRationale] = useState("");
  const router = useRouter();
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chunksRef = useRef<Blob[]>([]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
    localStorage.setItem(LOCAL_STORAGE_HISTORY_KEY, JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    localStorage.setItem(LOCAL_STORAGE_HISTORY_KEY + "_suggestions", JSON.stringify(suggestedActions));
  }, [suggestedActions]);

  const handleSubmit = async (e?: React.FormEvent, overrideText?: string) => {
    e?.preventDefault();
    const textToSubmit = overrideText || input;
    if (!textToSubmit.trim() || isTyping) return;

    const userMsg: ChatMessage = { id: Date.now().toString(), role: "user", text: textToSubmit };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    if (!overrideText) setInput("");
    setIsTyping(true);

    try {
      const apiMessages = newMessages.map(m => ({
        role: m.role === "agent" ? "assistant" : "user",
        content: m.text || "",
        ...(m.toolCall?.status === 'executed' && m.toolCall.id ? { 
          tool_calls: [{ id: m.toolCall.id, type: "function", function: { name: m.toolCall.name, arguments: JSON.stringify(m.toolCall.params) } }] 
        } : {})
      }));

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages, role: "Admin" })
      });

      const data = await res.json();
      
      const agentMsg: ChatMessage = { id: (Date.now() + 1).toString(), role: "agent", text: data.message || "" };
      
      if (data.tool_calls && data.tool_calls.length > 0) {
        const tc = data.tool_calls[0];
        agentMsg.toolCall = {
          id: tc.id,
          name: tc.function.name,
          params: JSON.parse(tc.function.arguments),
          status: "pending"
        };
      }
      
      setMessages(prev => [...prev, agentMsg]);

      // RAG-based Next Best Actions
      try {
        const api = (await import("@/app/services/api")).default;
        const tenantId = localStorage.getItem("tenant_id");
        if (tenantId) {
          const chatContext = newMessages.slice(-4).map(m => `${m.role}: ${m.text}`).join("\n");
          const suggestRes = await api.post("/agent/suggest-actions", { context: chatContext, tenant_id: tenantId });
          if (suggestRes.data?.suggested_actions?.length > 0) {
            setSuggestedActions(suggestRes.data.suggested_actions);
            setSuggestionRationale(suggestRes.data.rationale);
          } else {
            setSuggestedActions([]);
            setSuggestionRationale("");
          }
        }
      } catch (e) {
        console.error("Failed to fetch RAG suggestions", e);
      }

    } catch (err) {
      setMessages(prev => [...prev, { id: Date.now().toString(), role: "agent", text: "Oops, I encountered an error connecting to the brain." }]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleExecuteTool = async (msgId: string) => {
    const msg = messages.find(m => m.id === msgId);
    if (!msg || !msg.toolCall) return;

    // Optimistic UI update
    setMessages(prev => prev.map(m => m.id === msgId && m.toolCall ? { ...m, toolCall: { ...m.toolCall, status: "executed" } } : m));
    setIsTyping(true);

    try {
      const tenantId = localStorage.getItem("tenant_id");
      const { name, params } = msg.toolCall;
      
      let endpoint = "";
      let payload = params;

      const api = (await import("@/app/services/api")).default;

      let targetCaseId = "";
      if (name === "bulk_add_customers") {
        const customers = params.customers || params;
        const results = await Promise.allSettled(customers.map((c: any) => {
          const genderNormalized = c.gender ? c.gender.charAt(0).toUpperCase() + c.gender.slice(1).toLowerCase() : "Other";
          const income = typeof c.declared_income === "string" ? parseFloat(c.declared_income) : c.declared_income;
          return api.post(`/tenants/${tenantId}/customers`, {
             first_name: c.first_name,
             last_name: c.last_name,
             cnic: c.cnic,
             date_of_birth: c.date_of_birth,
             gender: genderNormalized,
             occupation: c.occupation,
             declared_income: income || 0,
             is_smoker: c.is_smoker ?? false,
             height_cm: c.height_cm ?? 170,
             weight_kg: c.weight_kg ?? 70
          });
        }));
        const successCount = results.filter(r => r.status === 'fulfilled').length;
        if (successCount === 0) throw new Error("All customer additions failed.");
      } else if (name === "add_customer") {
        try {
          await api.post(`/tenants/${tenantId}/customers`, {
            first_name: params.first_name,
            last_name: params.last_name,
            cnic: params.cnic,
            date_of_birth: params.date_of_birth,
            gender: params.gender,
            occupation: params.occupation,
            declared_income: params.declared_income,
            is_smoker: false,
            height_cm: 170,
            weight_kg: 70,
            details: {}
          });
        } catch (err: any) {
          if (err.message && err.message.toLowerCase().includes("already registered")) {
            console.log("Customer already exists, proceeding gracefully.");
          } else {
            throw err;
          }
        }
      } else if (name === "add_organization") {
        await api.post(`/tenants/${tenantId}/organizations`, params);
      } else if (name === "create_case") {
        const list = await api.get(`/tenants/${tenantId}/customers`);
        const customer = list.data.find((c: any) => {
          if (params.cnic && c.cnic === params.cnic) return true;
          if (!params.applicant_name) return false;
          const nameMatch = params.applicant_name.toLowerCase();
          return c.name?.toLowerCase().includes(nameMatch) || 
                 c.first_name?.toLowerCase().includes(nameMatch) || 
                 c.last_name?.toLowerCase().includes(nameMatch);
        });
        if (!customer) throw new Error(`Could not find a customer matching the provided details. Please add them first.`);
        
        const res = await api.post(`/tenants/${tenantId}/cases`, {
          customer_id: customer.id,
          caseType: params.case_type || "Underwriting",
          priorityLevel: params.priority_level || "Normal",
          sourceChannel: "Online"
        });
        targetCaseId = res.data?.caseld;
      } else if (name === "run_risk_assessment") {
        const list = await api.get(`/tenants/${tenantId}/cases`);
        const c = list.data.find((c: any) => {
          if (params.case_number && c.caseNumber === params.case_number) return true;
          if (params.cnic && c.customer_cnic === params.cnic) return true;
          if (!params.applicant_name) return false;
          const nameMatch = params.applicant_name.toLowerCase();
          return c.applicant_name?.toLowerCase().includes(nameMatch) ||
                 c.customer_name?.toLowerCase().includes(nameMatch);
        });
        
        if (!c) {
          const identifier = params.cnic || params.applicant_name || params.case_number;
          setMessages(prev => [...prev, {
            id: Date.now().toString(),
            role: "agent",
            text: `It looks like ${identifier} doesn't have an active insurance case yet. We need to create an application case for them before we can evaluate their risk profile.`,
            quickActionText: `Create an underwriting case for ${identifier}`,
            quickActionLabel: "Create Case Now"
          }]);
          setMessages(prev => prev.map(m => m.id === msgId && m.toolCall ? { ...m, toolCall: { ...m.toolCall, status: "pending" } } : m));
          setIsTyping(false);
          return;
        }

        const detailRes = await api.get(`/tenants/${tenantId}/cases/${c.caseld}/detail`);
        const { customer, policy, document_checklist } = detailRes.data;
        if (!customer || !policy) throw new Error("Missing applicant or policy details to run assessment.");

        if (document_checklist && document_checklist.missing && document_checklist.missing.length > 0) {
          const missingDocs = document_checklist.missing.join(", ");
          setMessages(prev => [...prev, {
            id: Date.now().toString(),
            role: "agent",
            text: `Missing required documents for this case: ${missingDocs}. Please upload them before running the assessment.`,
            quickActionText: "$UPLOAD",
            quickActionLabel: `Upload ${missingDocs}`
          }]);
          setMessages(prev => prev.map(m => m.id === msgId && m.toolCall ? { ...m, toolCall: { ...m.toolCall, status: "pending" } } : m));
          setIsTyping(false);
          return;
        }

        await api.post(`/evaluate`, { applicant: customer, policy, case_id: c.caseld });
        targetCaseId = c.caseld;
      } else if (name === "navigate_to_page") {
        // Nothing needed here, handled below in the actionLink logic
      } else if (name === "upload_document") {
        if (!selectedFile) throw new Error("No file was attached. Please attach the document using the paperclip icon first.");
        
        const list = await api.get(`/tenants/${tenantId}/cases`);
        const c = list.data.find((c: any) => {
          if (params.cnic && c.customer_cnic === params.cnic) return true;
          if (!params.applicant_name) return false;
          const nameMatch = params.applicant_name.toLowerCase();
          return c.applicant_name?.toLowerCase().includes(nameMatch) ||
                 c.customer_name?.toLowerCase().includes(nameMatch);
        });
        if (!c) throw new Error(`Could not find a case matching the provided details.`);

        const form = new FormData();
        form.append("document_type", params.document_type);
        form.append("file", selectedFile);
        
        await api.post(`/tenants/${tenantId}/cases/${c.caseld}/artifacts`, form, { headers: { "Content-Type": "multipart/form-data" } });
        setSelectedFile(null);
        targetCaseId = c.caseld;
      }

      let actionLink = "";
      let actionLabel = "";
      if (name === "add_customer" || name === "bulk_add_customers") {
        actionLink = params.cnic ? `/admin/leads?cnic=${params.cnic}` : "/admin/leads";
        actionLabel = "View Leads";
      } else if (name === "create_case" || name === "run_risk_assessment" || name === "upload_document") {
        actionLink = targetCaseId ? `/cases?case_id=${targetCaseId}` : "/cases";
        actionLabel = "View Case";
      } else if (name === "add_organization") {
        actionLink = "/admin/organizations";
        actionLabel = "View Organizations";
      } else if (name === "navigate_to_page") {
        let p = params.page_name || "dashboard";
        if (p === "dashboard") p = "";
        actionLink = `/${p}`;
        actionLabel = `Go to ${params.page_name?.replace(/[-/]/g, " ") || "Dashboard"}`;
      }

      const successMsg = {
        id: Date.now().toString(),
        role: "agent" as const,
        text: `✅ Successfully executed the \`${name}\` workflow!`,
        actionLink,
        actionLabel
      };
      
      setMessages(prev => {
        const next = [...prev, successMsg];
        
        // RAG-based Next Best Actions trigger in background
        const tenantId = localStorage.getItem("tenant_id");
        if (tenantId) {
          const chatContext = next.slice(-4).map(m => `${m.role}: ${m.text}`).join("\n");
          api.post("/agent/suggest-actions", { context: chatContext, tenant_id: tenantId })
            .then(suggestRes => {
              if (suggestRes.data?.suggested_actions?.length > 0) {
                setSuggestedActions(suggestRes.data.suggested_actions);
                setSuggestionRationale(suggestRes.data.rationale);
              } else {
                setSuggestedActions([]);
                setSuggestionRationale("");
              }
            })
            .catch(e => console.error("Failed to fetch RAG suggestions", e));
        }
        
        return next;
      });

      if (name === "create_case") {
        setTimeout(() => {
          setMessages(prev => [...prev, {
            id: Date.now().toString() + "_2",
            role: "agent",
            text: `Would you like to upload the required documents (like CNIC) for this case now?`,
            quickActionText: "$UPLOAD",
            quickActionLabel: "Upload Documents"
          }]);
        }, 500);
      }
    } catch (err: any) {
      const failMsg = {
        id: Date.now().toString(),
        role: "agent" as const,
        text: `❌ Failed to execute: ${err.message}`
      };
      
      setMessages(prev => {
        const next = [...prev, failMsg];
        
        // Revert status of tool call
        const reverted = next.map(m => m.id === msgId && m.toolCall ? { ...m, toolCall: { ...m.toolCall, status: "pending" as const } } : m);
        
        // Fetch new suggestions based on failure context
        const tenantId = localStorage.getItem("tenant_id");
        if (tenantId) {
          const chatContext = reverted.slice(-4).map(m => `${m.role}: ${m.text}`).join("\n");
          import("@/app/services/api").then(mod => {
            mod.default.post("/agent/suggest-actions", { context: chatContext, tenant_id: tenantId })
              .then(suggestRes => {
                if (suggestRes.data?.suggested_actions?.length > 0) {
                  setSuggestedActions(suggestRes.data.suggested_actions);
                  setSuggestionRationale(suggestRes.data.rationale);
                }
              })
              .catch(e => console.error("Failed to fetch RAG suggestions on fail", e));
          });
        }
        
        return reverted;
      });
    } finally {
      setIsTyping(false);
    }
  };

  const clearChat = () => {
    setMessages([{ id: "1", role: "agent", text: "Hello! I am your AI Underwriting Copilot. What would you like to automate today?" }]);
    localStorage.removeItem(LOCAL_STORAGE_HISTORY_KEY);
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
        setIsTyping(true);
        try {
          const fd = new FormData();
          fd.append("audio", blob, "recording.webm");
          const sttRes = await fetch("/api/stt", { method: "POST", body: fd });
          if (!sttRes.ok) throw new Error("STT failed");
          const { transcript } = await sttRes.json();
          if (transcript?.trim()) {
            await handleSubmit(undefined, transcript);
          } else {
            setIsTyping(false);
          }
        } catch {
          setMessages(prev => [...prev, { id: Date.now().toString(), role: "agent", text: "⚠️ Could not transcribe audio. Please try again." }]);
          setIsTyping(false);
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
    <div className="flex flex-col h-full bg-white relative animate-in fade-in duration-500">
      {/* Voice Agent Overlay */}
      {showVoice && <VoiceOverlay onClose={() => setShowVoice(false)} />}
      
      {/* Background Decor */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-blue-50/50 via-slate-50/30 to-white pointer-events-none"></div>

      {/* Header */}
      <div className="flex-shrink-0 px-5 py-3 border-b border-slate-200/60 flex items-center justify-between z-10 bg-white/70 backdrop-blur-xl sticky top-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-white flex items-center justify-center shadow-md shadow-blue-900/5 border border-slate-100 overflow-hidden shrink-0">
            <img src="/rizvi.png" alt="Rizviz Logo" className="w-6 h-6 object-contain drop-shadow-sm" />
          </div>
          <div className="flex flex-col justify-center">
            <h1 className="text-lg font-extrabold bg-gradient-to-r from-slate-900 to-slate-700 bg-clip-text text-transparent tracking-tight leading-tight">Rizviz AI Agent</h1>
            <p className="text-[11px] font-semibold text-slate-500 leading-tight">Intelligent Underwriting & Automation</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-1.5">
            <span className="flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest leading-none">Online</span>
          </div>
          <button onClick={clearChat} className="text-[9px] uppercase font-bold text-slate-400 hover:text-slate-700 transition-colors leading-none">Clear Chat</button>
        </div>
      </div>

      {/* Chat Feed */}
      <div className="flex-1 overflow-y-auto p-6 space-y-8 z-10 relative">
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-[0.03] z-0">
          <img src="/rizvi.png" alt="Rizviz Background" className="w-1/2 max-w-lg object-contain" />
        </div>
        <div className="max-w-4xl mx-auto space-y-8 pb-10 relative z-10">
          {messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} group animate-in slide-in-from-bottom-2 duration-300`}>
              
              {msg.role === 'agent' && (
                <div className="w-8 h-8 rounded-full bg-white border border-slate-200 shadow-sm flex flex-shrink-0 items-center justify-center mr-3 mt-1 overflow-hidden">
                  <img src="/rizvi.png" alt="Agent" className="w-6 h-6 object-contain" />
                </div>
              )}

              <div className={`max-w-[80%] flex flex-col gap-3 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                {/* Text Bubble */}
                {msg.text && (
                  <div className={`px-5 py-3.5 rounded-2xl text-[15px] leading-relaxed shadow-sm flex flex-col gap-3 ${
                    msg.role === 'user' 
                      ? 'bg-slate-900 text-white rounded-br-none' 
                      : 'bg-white border border-slate-200 text-slate-700 rounded-bl-none'
                  }`}>
                    <div>{msg.text}</div>
                    
                    {msg.actionLink && msg.actionLabel && (
                      <button 
                        onClick={() => router.push(msg.actionLink!)}
                        className="self-start mt-1 px-4 py-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-sm font-bold rounded-lg border border-emerald-200 transition-all flex items-center gap-2 shadow-sm"
                      >
                        {msg.actionLabel}
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                      </button>
                    )}

                    {msg.quickActionText && msg.quickActionLabel && (
                      <button 
                        onClick={() => {
                          if (msg.quickActionText === "$UPLOAD") {
                            setAutoSubmitPrompt(msg.quickActionLabel?.replace("Upload ", "") || "document");
                            fileInputRef.current?.click();
                          } else {
                            handleSubmit(undefined, msg.quickActionText);
                          }
                        }}
                        className="self-start mt-1 px-4 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-sm font-bold rounded-lg border border-indigo-200 transition-all flex items-center gap-2 shadow-sm"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><circle cx="12" cy="12" r="10"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>
                        {msg.quickActionLabel}
                      </button>
                    )}
                  </div>
                )}

                {/* Interactive Tool Card */}
                {msg.toolCall && (
                  <div className="w-full max-w-sm bg-white border border-indigo-100 rounded-2xl shadow-lg shadow-indigo-100/50 overflow-hidden">
                    <div className="bg-indigo-50/50 px-4 py-3 border-b border-indigo-100 flex items-center justify-between">
                      <span className="text-xs font-bold text-indigo-700 uppercase tracking-wider flex items-center gap-1.5">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                        Proposed Action
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">{msg.toolCall.name}</span>
                    </div>
                    <div className="p-4 bg-white space-y-3">
                      {Object.entries(msg.toolCall.params).map(([k, v]) => (
                        <div key={k} className="flex justify-between items-center text-sm">
                          <span className="text-slate-500 capitalize">{k.replace('_', ' ')}</span>
                          <span className="font-semibold text-slate-800">{String(v)}</span>
                        </div>
                      ))}
                      
                      <div className="pt-3 mt-3 border-t border-slate-100">
                        {msg.toolCall.status === 'pending' ? (
                          <button 
                            onClick={() => handleExecuteTool(msg.id)}
                            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-xl transition-all shadow-sm active:scale-[0.98]"
                          >
                            Execute Workflow
                          </button>
                        ) : (
                          <button disabled className="w-full py-2.5 bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm font-bold rounded-xl flex items-center justify-center gap-2">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><polyline points="20 6 9 17 4 12"/></svg>
                            Executed
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
          {isTyping && (
            <div className="flex justify-start items-center gap-2 text-slate-400 text-sm animate-pulse ml-12">
              <span className="w-2 h-2 rounded-full bg-indigo-400"></span>
              <span className="w-2 h-2 rounded-full bg-indigo-400"></span>
              <span className="w-2 h-2 rounded-full bg-indigo-400"></span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Pop-out Suggestions Panel (Floats outside Copilot) */}
      {suggestedActions.length > 0 && !isTyping && (
        <div className="absolute bottom-[100px] right-full mr-6 w-[280px] z-50 animate-in slide-in-from-right-8 fade-in duration-500 pointer-events-auto">
          <div className="bg-white/95 backdrop-blur-xl rounded-2xl shadow-[0_15px_50px_-12px_rgba(0,0,0,0.15)] border border-slate-200 p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2 px-1">
              <span className="flex h-2.5 w-2.5 items-center justify-center rounded-full bg-emerald-100">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              </span>
              <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Suggested Next Actions</span>
            </div>
            <div className="flex flex-col gap-2">
              {suggestedActions.map((action, idx) => (
                <button
                  key={idx}
                  onClick={() => {
                    setSuggestedActions([]);
                    handleSubmit(undefined, action);
                  }}
                  className="w-full text-left px-4 py-2.5 bg-slate-50 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 text-[13px] font-semibold rounded-xl border border-transparent hover:border-indigo-100 transition-all active:scale-[0.98]"
                >
                  {action}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Input Area */}
      <div className="flex-shrink-0 p-6 bg-white border-t border-slate-100 z-20 shadow-[0_-10px_40px_-15px_rgba(0,0,0,0.05)]">
        <div className="max-w-4xl mx-auto">
          {selectedFile && (
            <div className="mb-3 flex items-center gap-2">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-indigo-50 text-indigo-700 text-xs font-semibold rounded-lg border border-indigo-100">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                {selectedFile.name}
                <button type="button" onClick={() => setSelectedFile(null)} className="ml-1 hover:text-indigo-900 transition-colors">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>
          )}
          <form onSubmit={handleSubmit} className="relative flex items-center">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask Copilot to automate a task..."
              className="w-full bg-slate-50 border border-slate-200 text-slate-900 rounded-2xl pl-6 pr-[200px] py-4 shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-all text-base placeholder:text-slate-400"
            />
            <div className="absolute right-2 flex items-center gap-1">
              <input
                type="file"
                ref={fileInputRef}
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    const file = e.target.files[0];
                    setSelectedFile(file);
                    if (autoSubmitPrompt) {
                      handleSubmit(undefined, `Upload ${file.name} as ${autoSubmitPrompt} for this case.`);
                      setAutoSubmitPrompt("");
                    }
                  }
                }}
                className="hidden"
                accept=".pdf,.png,.jpg,.jpeg,.tiff,.bmp"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Attach Document"
                className="p-2.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
              </button>

              <button
                type="button"
                onClick={() => setShowVoice(true)}
                title="Live Voice Agent"
                className="p-2.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 18v-6a9 9 0 0118 0v6M3 18a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3v5zm16 0a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3v5z" /></svg>
              </button>
              
              <button
                type="button"
                onMouseDown={startRecording}
                onMouseUp={stopRecording}
                onMouseLeave={() => isRecording && stopRecording()}
                title="Hold to dictate"
                className={`p-2.5 rounded-xl transition-all ${isRecording ? "bg-rose-100 text-rose-600 animate-pulse" : "text-slate-400 hover:text-indigo-600 hover:bg-indigo-50"}`}
              >
                {isRecording ? (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                )}
              </button>

              <button 
                type="submit"
                disabled={!input.trim() || isTyping}
                className="p-3 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 disabled:from-slate-300 disabled:to-slate-300 text-white rounded-xl transition-all shadow-md active:scale-95"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
              </button>
            </div>
          </form>
          <div className="flex items-center justify-center gap-6 mt-4">
            <button onClick={() => setInput("Add a new individual applicant")} className="text-xs text-slate-400 hover:text-indigo-600 font-medium transition-colors">"Add a new individual applicant"</button>
            <button onClick={() => setInput("Evaluate risk profile")} className="text-xs text-slate-400 hover:text-indigo-600 font-medium transition-colors">"Evaluate risk profile"</button>
            <button onClick={() => setInput("Find high risk policies")} className="text-xs text-slate-400 hover:text-indigo-600 font-medium transition-colors">"Find high risk policies"</button>
          </div>
        </div>
      </div>
    </div>
  );
}
