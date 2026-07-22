"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import VoiceOverlay from "./VoiceOverlay";
import { useRouter } from "next/navigation";
import api from "../app/services/api";

interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  rawText?: string;
  quickActions?: { label: string; actionType: "navigate" | "submit" | "upload"; payload: string }[];
}

const LOCAL_STORAGE_HISTORY_KEY = "copilot_history";

export function CopilotInterface() {
  const router = useRouter();
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
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem(LOCAL_STORAGE_HISTORY_KEY + "_suggestions");
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
  const pendingUploadRef = useRef<{document_type: string, cnic: string} | null>(null);

  useEffect(() => { selectedFileRef.current = selectedFile; }, [selectedFile]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    localStorage.setItem(LOCAL_STORAGE_HISTORY_KEY, JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    localStorage.setItem(LOCAL_STORAGE_HISTORY_KEY + "_suggestions", JSON.stringify(suggestedActions));
  }, [suggestedActions]);

  // ── Tool Executor (zero-click, runs automatically) ─────────────────────────
  const executeLocalTool = useCallback(async (name: string, argsRaw: string) => {
    let args: any = {};
    try { args = typeof argsRaw === "string" ? JSON.parse(argsRaw) : argsRaw; } catch {}

    let result: any = { success: false, message: "Unknown tool" };
    const tenantId = localStorage.getItem("tenant_id") || "00000000-0000-0000-0000-000000000001";

    try {
      if (name === "navigate_to_page") {
        const path = args.page_name === "dashboard" ? "" : args.page_name;
        router.push(`/${path}`);
        result = { success: true, message: `Navigated to ${args.page_name}` };

      } else if (name === "add_user") {
        const rolesRes = await api.get(`/roles`);
        const role = rolesRes.data.find((r: any) => r.name.toLowerCase() === args.role_name.toLowerCase());
        if (!role) throw new Error(`Role ${args.role_name} not found`);
        const res = await api.post(`/tenants/${tenantId}/users/`, {
          full_name: args.full_name,
          email: args.email,
          role_id: role.id
        });
        result = { success: true, user_id: res.data.id, message: `User ${args.full_name} added as ${args.role_name}.` };

      } else if (name === "add_organization") {
        const res = await api.post(`/tenants/${tenantId}/organizations`, {
          name: args.name,
          contact_person: args.contact_person,
          contact_email: args.contact_email,
          contact_phone: args.contact_phone
        });
        result = { success: true, organization_id: res.data.id, message: `Organization "${args.name}" added.` };

      } else if (name === "add_family_group") {
        const res = await api.post(`/tenants/${tenantId}/families`, {
          name: args.name,
          contact_person: args.contact_person,
          contact_email: args.contact_email,
          contact_phone: args.contact_phone,
          household_declared_income: args.household_declared_income
        });
        const familyId = res.data.id;
        let message = `Family Group "${args.name}" added.`;
        if (args.members && Array.isArray(args.members) && args.members.length > 0) {
          const fpRes = await api.post(`/tenants/${tenantId}/families/${familyId}/floater-policies`, {
            total_sum_insured: 5000000,
            term_years: 1,
            effective_date: new Date().toISOString().split("T")[0]
          });
          await api.post(`/tenants/${tenantId}/families/${familyId}/floater-policies/${fpRes.data.id}/members/confirm`, {
            members: args.members
          });
          message += ` Enrolled ${args.members.length} members.`;
        }
        result = { success: true, family_group_id: familyId, message };

      } else if (name === "bulk_add_customers") {
        let customers: any[] = [];
        try {
          let jsonStr = args.customers_json || args.customers;
          if (typeof jsonStr === "string") {
            jsonStr = jsonStr.replace(/^```[a-z]*\n/i, "").replace(/\n```$/i, "").trim();
            customers = JSON.parse(jsonStr);
          } else {
            customers = jsonStr;
          }
        } catch (e: any) {
          throw new Error("Invalid customers JSON: " + e.message);
        }
        if (!Array.isArray(customers)) throw new Error("Expected an array of customers.");
        const results = await Promise.allSettled(customers.map((c: any) => {
          const gender = c.gender ? c.gender.charAt(0).toUpperCase() + c.gender.slice(1).toLowerCase() : "Other";
          const income = typeof c.declared_income === "string" ? parseFloat(c.declared_income) : c.declared_income;
          return api.post(`/tenants/${tenantId}/customers`, {
            first_name: c.first_name, last_name: c.last_name, cnic: c.cnic,
            date_of_birth: c.date_of_birth, gender, occupation: c.occupation,
            declared_income: income || 0, is_smoker: c.is_smoker ?? false,
            height_cm: c.height_cm ?? 170, weight_kg: c.weight_kg ?? 70
          });
        }));
        const successCount = results.filter(r => r.status === "fulfilled").length;
        const failCount = results.length - successCount;
        if (successCount === 0 && failCount > 0) {
          const firstErr = (results.find(r => r.status === "rejected") as any)?.reason;
          throw new Error("All additions failed. " + (firstErr?.response?.data?.detail || firstErr?.message));
        }
        result = { 
          success: true, 
          message: `Added ${successCount} customers. Failed: ${failCount}.`,
          quickActions: [
            { label: "View Leads", actionType: "navigate", payload: "admin/leads" }
          ]
        };

      } else if (name === "add_customer") {
        const gender = args.gender ? args.gender.charAt(0).toUpperCase() + args.gender.slice(1).toLowerCase() : "Other";
        const income = typeof args.declared_income === "string" ? parseFloat(args.declared_income) : args.declared_income;
        let dob = args.date_of_birth;
        if (dob && dob.length > 10) { try { dob = new Date(dob).toISOString().split("T")[0]; } catch {} }
        const res = await api.post(`/tenants/${tenantId}/customers`, {
          first_name: args.first_name, last_name: args.last_name, cnic: args.cnic,
          date_of_birth: dob, gender, occupation: args.occupation,
          declared_income: income || 0, is_smoker: false, height_cm: 170, weight_kg: 70, details: {}
        });
        result = { 
          success: true, 
          customer_id: res.data.id, 
          message: "Customer added successfully.",
          quickActions: [
            { label: "View Lead", actionType: "navigate", payload: args.cnic ? `admin/leads?cnic=${args.cnic}` : "admin/leads" },
            { label: "Create Case", actionType: "submit", payload: args.cnic ? `Create a case for CNIC ${args.cnic}` : `Create a case for ${args.first_name} ${args.last_name}` }
          ]
        };

      } else if (name === "delete_customer") {
        const params = new URLSearchParams();
        if (args.cnic) params.append("cnic", args.cnic);
        if (args.name) params.append("name", args.name);
        const list = await api.get(`/tenants/${tenantId}/customers?${params.toString()}`);
        if (!list.data || list.data.length === 0) throw new Error("Customer not found");
        const customer = list.data[0];
        await api.delete(`/tenants/${tenantId}/customers/${customer.id}`);
        result = { success: true, message: `Customer ${customer.name || args.name} deleted.` };

      } else if (name === "get_case_details") {
        const list = await api.get(`/tenants/${tenantId}/cases`);
        const c = list.data.find((c: any) =>
          (args.case_number && c.caseNumber === args.case_number) ||
          (args.applicant_name && c.applicant_name?.toLowerCase().includes(args.applicant_name.toLowerCase()))
        );
        if (!c) throw new Error("Case not found");
        result = { success: true, case_number: c.caseNumber, status: c.caseStatus, applicant: c.applicant_name, ai_decision: c.latest_ai_decision || "Pending" };

      } else if (name === "create_case") {
        const list = await api.get(`/tenants/${tenantId}/customers`);
        const customer = list.data.find((c: any) => {
          if (args.cnic && c.cnic === args.cnic) return true;
          if (!args.applicant_name) return false;
          const n = args.applicant_name.toLowerCase();
          const fullName = `${c.first_name || ''} ${c.last_name || ''}`.trim().toLowerCase();
          return c.name?.toLowerCase().includes(n) || fullName.includes(n) || c.first_name?.toLowerCase().includes(n) || c.last_name?.toLowerCase().includes(n);
        });
        if (!customer) throw new Error(`No customer found for "${args.applicant_name || args.cnic}". Add them first.`);
        const res = await api.post(`/tenants/${tenantId}/cases`, {
          customer_id: customer.id,
          caseType: args.case_type || "Underwriting",
          priorityLevel: args.priority_level || "Normal",
          sourceChannel: "Online"
        });
        result = { 
          success: true, 
          case_id: res.data?.caseld, 
          message: `Case created for ${customer.first_name || customer.name}.`,
          quickActions: [
            { label: "View Case", actionType: "navigate", payload: res.data?.caseld ? `cases?case_id=${res.data.caseld}` : "cases" },
            { label: "Run Risk Assessment", actionType: "submit", payload: `Run risk assessment for case ${res.data?.caseld}` }
          ]
        };

      } else if (name === "run_risk_assessment") {
        const list = await api.get(`/tenants/${tenantId}/cases`);
        const c = list.data.find((c: any) => {
          if (args.case_number && c.caseNumber === args.case_number) return true;
          if (args.cnic && c.customer_cnic === args.cnic) return true;
          if (!args.applicant_name) return false;
          const n = args.applicant_name.toLowerCase();
          const fullName = `${c.applicant_name || ''} ${c.customer_name || ''}`.trim().toLowerCase();
          return fullName.includes(n) || c.applicant_name?.toLowerCase().includes(n) || c.customer_name?.toLowerCase().includes(n);
        });
        if (!c) throw new Error(`No case found for "${args.applicant_name || args.cnic}". Create a case first.`);
        const detailRes = await api.get(`/tenants/${tenantId}/cases/${c.caseld}/detail`);
        const { customer, policy, document_checklist } = detailRes.data;
        if (!customer) throw new Error("Missing applicant details.");
        
        if (!policy) {
          result = {
            success: false,
            message: `Cannot run risk assessment. No insurance policy or proposal is associated with this case yet.`,
            quickActions: [
              { label: "Create Proposal", actionType: "submit", payload: `Create a standard Term Life proposal for CNIC ${c.customer_cnic || args.cnic}` }
            ]
          };
        } else if (document_checklist && document_checklist.missing && document_checklist.missing.length > 0) {
          result = {
            success: false,
            message: `Cannot run risk assessment yet. Missing documents: ${document_checklist.missing.join(", ")}.`,
            quickActions: document_checklist.missing.map((doc: string) => ({
              label: `Upload ${doc}`,
              actionType: "upload",
              payload: JSON.stringify({ document_type: doc, cnic: c.customer_cnic || args.cnic })
            }))
          };
        } else {
          await api.post(`/evaluate`, { applicant: customer, policy, case_id: c.caseld });
          result = { 
            success: true, 
            message: "Risk assessment triggered. Results will be ready shortly.",
            quickActions: [
              { label: "View Case", actionType: "navigate", payload: c.caseld ? `cases?case_id=${c.caseld}` : "cases" }
            ]
          };
        }

      } else if (name === "create_proposal") {
        const list = await api.get(`/tenants/${tenantId}/customers`);
        const customer = list.data.find((c: any) => {
          if (args.customer_id && c.id === args.customer_id) return true;
          if (args.cnic && c.cnic === args.cnic) return true;
          if (!args.applicant_name) return false;
          const n = args.applicant_name.toLowerCase();
          const fullName = `${c.first_name || ''} ${c.last_name || ''}`.trim().toLowerCase();
          return c.name?.toLowerCase().includes(n) || fullName.includes(n) || c.first_name?.toLowerCase().includes(n) || c.last_name?.toLowerCase().includes(n);
        });
        if (!customer) throw new Error(`No customer found for "${args.applicant_name || args.cnic}". Add them first.`);
        
        const res = await api.post(`/tenants/${tenantId}/customers/${customer.id}/policies`, {
          product_name: args.product_name || "Term Life Plus",
          insurance_type: args.insurance_type || "Life",
          coverage_amount: args.coverage_amount || 5000000,
          term_years: args.term_years || 10
        });
        
        result = { 
          success: true, 
          policy_id: res.data.id, 
          message: `Proposal created successfully for ${customer.name || customer.first_name}.`,
          quickActions: [
            { label: "Run Risk Assessment", actionType: "submit", payload: `Run risk assessment for CNIC ${customer.cnic}` }
          ]
        };

      } else if (name === "upload_document") {
        const file = selectedFileRef.current;
        if (!file) throw new Error("No file attached. Please attach a document using the paperclip icon first.");
        const list = await api.get(`/tenants/${tenantId}/cases`);
        const c = list.data.find((c: any) => {
          if (args.cnic && c.customer_cnic === args.cnic) return true;
          if (!args.applicant_name) return false;
          const n = args.applicant_name.toLowerCase();
          const fullName = `${c.applicant_name || ''} ${c.customer_name || ''}`.trim().toLowerCase();
          return fullName.includes(n) || c.applicant_name?.toLowerCase().includes(n) || c.customer_name?.toLowerCase().includes(n);
        });
        if (!c) throw new Error("No case found for this applicant.");
        const form = new FormData();
        form.append("document_type", args.document_type);
        form.append("file", file);
        await api.post(`/tenants/${tenantId}/cases/${c.caseld}/artifacts`, form, { headers: { "Content-Type": "multipart/form-data" } });
        setSelectedFile(null);
        result = { success: true, message: `${args.document_type} uploaded successfully.` };
      }
    } catch (e: any) {
      console.error(`[Copilot] Tool error [${name}]:`, e);
      result = { success: false, error: e.response?.data?.detail || e.message || "Tool execution failed." };
    }
    return JSON.stringify(result);
  }, [router]);

  // ── Agentic Submit — while(true) loop, zero confirmation clicks ────────────
  const handleSubmit = useCallback(async (e?: React.FormEvent, overrideText?: string) => {
    e?.preventDefault();
    const text = overrideText || input;
    if (!text.trim() || isTyping) return;

    const userMsg: ChatMessage = { id: Date.now().toString(), role: "user", text };
    setMessages(prev => [...prev, userMsg]);
    if (!overrideText) setInput("");
    setIsTyping(true);

    // Build conversation history for the API (OpenAI-compatible format)
    const buildApiMessages = (msgs: ChatMessage[]) =>
      msgs.map(m => ({ role: m.role === "agent" ? "assistant" : "user", content: m.rawText || m.text || "" }));

    let currentMessages = buildApiMessages([...messages, userMsg]);
    let allQuickActions: any[] = [];

    try {
      const roleStr = typeof window !== "undefined" ? localStorage.getItem("user_role") || "Admin" : "Admin";

      while (true) {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: currentMessages.slice(-20), role: roleStr })
        });
        if (!res.ok) throw new Error("Chat API failed");
        const data = await res.json();

        // Add AI text response to chat (if any)
        if (data.message) {
          let finalText = data.message;
          const match = finalText.match(/<quick_actions>([\s\S]*?)<\/quick_actions>/i);
          if (match) {
            finalText = finalText.replace(match[0], '').trim();
            const options = match[1].split('\n').map((l: string) => l.trim()).filter((l: string) => l.startsWith('[') && l.endsWith(']'));
            options.forEach((opt: string) => {
              const val = opt.slice(1, -1).trim();
              allQuickActions.push({ label: val, actionType: 'submit', payload: val });
            });
          }

          const agentMsg: ChatMessage = { id: Date.now().toString(), role: "agent", text: finalText, rawText: data.message };
          setMessages(prev => [...prev, agentMsg]);
          currentMessages = [...currentMessages, { role: "assistant", content: data.message }];
        }

        const toolResults: any[] = [];
        
        // No tool calls → done
        if (!data.tool_calls || data.tool_calls.length === 0) {
          if (!data.message && toolResults.length === 0) {
            setMessages(prev => [...prev, { id: Date.now().toString(), role: "agent", text: "I'm having trouble processing that request. Please try again or rephrase." }]);
          }
          break;
        }

        // Execute ALL tools automatically — no user confirmation needed
        for (const tc of data.tool_calls) {
          const resultStr = await executeLocalTool(tc.function.name, tc.function.arguments);
          toolResults.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: resultStr });
          try {
             const parsed = JSON.parse(resultStr);
             if (parsed.quickActions) allQuickActions.push(...parsed.quickActions);
          } catch {}
        }

        // Feed results back so AI can summarize
        currentMessages = [
          ...currentMessages,
          { role: "assistant", content: data.message || "", tool_calls: data.tool_calls },
          ...toolResults
        ];
      }

      if (allQuickActions.length > 0) {
        setMessages(prev => {
          const copy = [...prev];
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].role === "agent") {
              const existingLabels = new Set(copy[i].quickActions?.map(a => a.label) || []);
              const newActions = allQuickActions.filter(a => !existingLabels.has(a.label));
              copy[i] = { ...copy[i], quickActions: [...(copy[i].quickActions || []), ...newActions] };
              break;
            }
          }
          return copy;
        });
      }
    } catch {
      setMessages(prev => [...prev, { id: Date.now().toString(), role: "agent", text: "⚠️ Error connecting to the server. Please try again." }]);
    } finally {
      setIsTyping(false);

      // Fire-and-forget RAG suggestions — completely off the critical path
      const tenantId = localStorage.getItem("tenant_id");
      if (tenantId) {
        setMessages(latest => {
          const ctx = latest.slice(-4).map(m => `${m.role}: ${m.text}`).join("\n");
          api.post("/agent/suggest-actions", { context: ctx, tenant_id: tenantId })
            .then(r => {
              if (r.data?.suggested_actions?.length > 0) {
                setSuggestedActions(r.data.suggested_actions);
              } else {
                setSuggestedActions([]);
              }
            })
            .catch(() => {});
          return latest;
        });
      }
    }
  }, [input, isTyping, messages, executeLocalTool]);

  const clearChat = () => {
    setMessages([{ id: "1", role: "agent", text: "Hello! I am your AI Underwriting Copilot. What would you like to automate today?" }]);
    setSuggestedActions([]);
    localStorage.removeItem(LOCAL_STORAGE_HISTORY_KEY);
    localStorage.removeItem(LOCAL_STORAGE_HISTORY_KEY + "_suggestions");
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
          if (transcript?.trim()) await handleSubmit(undefined, transcript);
          else setIsTyping(false);
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
              <button onClick={clearChat} title="Clear chat" className="p-2 rounded-full hover:bg-white/15 transition-colors">
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
                    {msg.role === "agent" && (
                      <div className="w-7 h-7 rounded-full bg-white border border-violet-100 shadow-sm flex flex-shrink-0 items-center justify-center overflow-hidden">
                        <img src="/rizvi.png" alt="Agent" className="w-5 h-5 object-contain" />
                      </div>
                    )}
                    <div className={`max-w-[82%] px-4 py-2.5 text-[14px] leading-relaxed shadow-sm whitespace-pre-wrap flex flex-col gap-3 ${
                      msg.role === "user"
                        ? "bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white rounded-2xl rounded-br-md"
                        : "bg-white border border-slate-100 text-slate-700 rounded-2xl rounded-bl-md"
                    }`}>
                      <div>{msg.text}</div>
                      {msg.quickActions && msg.quickActions.length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-1">
                          {msg.quickActions.map((action, idx) => (
                            <button
                              key={`${action.actionType}-${action.label}-${idx}`}
                              onClick={() => {
                                if (action.actionType === "navigate") router.push(`/${action.payload}`);
                                else if (action.actionType === "upload") {
                                  const data = JSON.parse(action.payload);
                                  pendingUploadRef.current = data;
                                  fileInputRef.current?.click();
                                }
                                else handleSubmit(undefined, action.payload);
                              }}
                              className={`px-3 py-1.5 text-[12px] font-bold rounded-full border transition-all flex items-center gap-1.5 shadow-sm active:scale-95 ${
                                action.actionType === "navigate"
                                  ? "bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200"
                                  : action.actionType === "upload"
                                  ? "bg-amber-50 hover:bg-amber-100 text-amber-700 border-amber-200"
                                  : "bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border-indigo-200"
                              }`}
                            >
                              {action.actionType === "navigate" ? (
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                              ) : action.actionType === "upload" ? (
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                              ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>
                              )}
                              {action.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {isTyping && (
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
                  onChange={(e) => {
                    if (e.target.files && e.target.files.length > 0) {
                      const file = e.target.files[0];
                      setSelectedFile(file);
                      selectedFileRef.current = file;
                      if (pendingUploadRef.current) {
                        const { document_type, cnic } = pendingUploadRef.current;
                        pendingUploadRef.current = null;
                        handleSubmit(undefined, `Upload ${document_type} for CNIC ${cnic}`);
                      } else if (autoSubmitPrompt) {
                        handleSubmit(undefined, `Upload ${file.name} as ${autoSubmitPrompt} for this case.`);
                        setAutoSubmitPrompt("");
                      }
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
                    placeholder="Message…"
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
                <button type="submit" disabled={!input.trim() || isTyping}
                  className="p-3 bg-gradient-to-br from-violet-500 to-fuchsia-500 hover:from-violet-600 hover:to-fuchsia-600 disabled:from-slate-300 disabled:to-slate-300 text-white rounded-full transition-all shadow-lg shadow-fuchsia-500/30 active:scale-90 shrink-0">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                </button>
              </form>
              {/* Quick prompt chips */}
              <div className="flex items-center justify-center gap-1.5 mt-2 flex-wrap">
                {["Add a new individual applicant", "Evaluate risk profile", "Find high risk policies"].map((q) => (
                  <button key={q} onClick={() => setInput(q)} className="text-[10px] text-violet-500 hover:text-white hover:bg-violet-500 border border-violet-200 px-2.5 py-1 rounded-full font-medium transition-all">
                    {q}
                  </button>
                ))}
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* ── Floating Suggestions Panel ─────────────────────────────────── */}
      {suggestedActions.length > 0 && !isTyping && (
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

