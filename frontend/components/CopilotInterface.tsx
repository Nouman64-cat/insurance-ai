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
import { useCopilot } from "./CopilotContext";
import { RiskScoreBar, CompositeScoreRing } from "@/components/RiskScoreBar";

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
      { label: "Start underwriting", actionType: "submit", payload: "Start underwriting journey for a customer" },
      { label: "Create a proposal", actionType: "submit", payload: "Create a proposal for a customer" },
      { label: "Check pending cases", actionType: "submit", payload: "Show me all pending cases" },
      { label: "View dashboard stats", actionType: "submit", payload: "Show me the dashboard statistics" },
      { label: "List active quotes", actionType: "submit", payload: "List all quotes" },
      { label: "Search records", actionType: "submit", payload: "Search for a customer by name" },
      { label: "Test with demo data", actionType: "submit", payload: "Test the full workflow with demo data" },
    ];
  }

  const text = (lastMessage.text || "").toLowerCase();
  
  if (text.includes("missing documents") || (text.includes("upload") && text.includes("document"))) {
    const isCNIC = text.includes("cnic");
    const isMed = text.includes("medical");
    const isSalary = text.includes("salary");
    const actions = [];
    if (isCNIC || (!isCNIC && !isMed && !isSalary)) actions.push({ label: "Upload CNIC", actionType: "upload", payload: JSON.stringify({ document_type: "CNIC" }) });
    if (isMed || (!isCNIC && !isMed && !isSalary)) actions.push({ label: "Upload Medical Report", actionType: "upload", payload: JSON.stringify({ document_type: "Medical Report" }) });
    if (isSalary || (!isCNIC && !isMed && !isSalary)) actions.push({ label: "Upload Salary Slip", actionType: "upload", payload: JSON.stringify({ document_type: "Salary Slip" }) });
    actions.push({ label: "I have uploaded them", actionType: "submit", payload: "I have uploaded the documents. Please check and proceed." });
    return actions;
  }


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
  const { isAutomationMode, setAutomationMode } = useCopilot();

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

  const { messages, send, resolveInterrupt, isLoading, pendingInterrupt, clearChat, loadChat, steps, turnActions } = useAgentChat({
    storageKey: STORAGE_KEY,
    welcomeMessage: WELCOME,
    onNavigate: handleAgentNavigate,
  });

  const [input, setInput] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedFileUrl, setSelectedFileUrl] = useState<string | null>(null);
  const [autoSubmitPrompt, setAutoSubmitPrompt] = useState("");
  const [riskSteps, setRiskSteps] = useState<ProcessStep[]>([]);
  const [uploadedDocs, setUploadedDocs] = useState<string[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const interruptRiskRef = useRef<boolean>(false);

  useEffect(() => {
    if (selectedFile && selectedFile.type.startsWith("image/")) {
      const url = URL.createObjectURL(selectedFile);
      setSelectedFileUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setSelectedFileUrl(null);
    }
  }, [selectedFile]);
  const [suggestedActions, setSuggestedActions] = useState<string[]>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem(STORAGE_KEY + "_suggestions");
        if (saved) return JSON.parse(saved);
      } catch { }
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

  const scrollContainerRef = useRef<HTMLDivElement>(null);
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
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: "smooth"
      });
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
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

  // Client-executed risk assessment (so we can stream the live steps to the UI)
  useEffect(() => {
    if (pendingInterrupt?.kind !== "client_execute") return;
    if (pendingInterrupt.toolCall.name !== "run_risk_assessment") return;
    
    if (interruptRiskRef.current) return;
    interruptRiskRef.current = true;
    
    setRiskSteps([
      { id: "medical", label: "Analyzing medical history", status: "active" }
    ]);
    
    const args = pendingInterrupt.toolCall.args;
    
    (async () => {
      try {
        const tenantId = localStorage.getItem("tenant_id") || "00000000-0000-0000-0000-000000000001";
        const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8010";
        
        const payload = {
          customer: args.customer,
          policy: args.policy,
          case_id: args.case_id,
        };

        const res = await fetch(`${API_BASE}/evaluate/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Tenant-Id": tenantId },
          body: JSON.stringify(payload),
        });

        if (!res.ok) throw new Error("Stream failed");

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        
        let finalScores: any = {};
        let finalDecision = "";
        
        const updateStep = (id: string, label: string, status: "active" | "done" | "error") => {
          setRiskSteps(prev => {
            const copy = [...prev];
            const idx = copy.findIndex(s => s.id === id);
            if (idx >= 0) copy[idx] = { id, label, status };
            else copy.push({ id, label, status });
            return copy;
          });
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;
            let evt: any;
            try { evt = JSON.parse(line.slice(6)); } catch { continue; }

            if (evt.type === "progress") {
              const node = evt.node;
              const data = evt.data || {};
              if (node === "medical_scoring") {
                 updateStep("medical", "Analyzing medical history", "done");
                 updateStep("financial", "Evaluating financial profile", "active");
                 finalScores.medical_score = data.medical_score;
                 finalScores.medical_reasons = data.medical_reasons ?? [];
              } else if (node === "financial_scoring") {
                 updateStep("financial", "Evaluating financial profile", "done");
                 updateStep("fraud", "Checking fraud signals", "active");
                 finalScores.financial_score = data.financial_score;
                 finalScores.financial_reasons = data.financial_reasons ?? [];
              } else if (node === "fraud_detection") {
                 updateStep("fraud", "Checking fraud signals", "done");
                 updateStep("decision", "Calculating composite risk", "active");
                 finalScores.fraud_probability = data.fraud_probability;
                 finalScores.fraud_reasons = data.fraud_reasons ?? [];
              } else if (node === "decision_aggregation") {
                 updateStep("decision", "Calculating composite risk", "done");
                 finalScores.composite_risk_score = data.composite_risk_score;
                 finalDecision = data.ai_decision;
                 finalScores.reasons = data.reasons ?? [];
              }
            } else if (evt.type === "invalid" || evt.type === "error") {
               updateStep("error", "Assessment failed", "error");
               throw new Error(evt.message || "Validation failed");
            }
          }
        }
        
        const summary = `Assessment complete for **${args.case_id}**\n- Medical: ${finalScores.medical_score ?? '—'}/100\n- Financial: ${finalScores.financial_score ?? '—'}/100\n- Fraud: ${finalScores.fraud_probability ?? '—'}\n- **Decision: ${finalDecision}**`;
        const results_route = `case/${args.case_id}`;

        resolveInterrupt({
          success: true,
          message: summary,
          assessment: {
            scores: finalScores,
            ai_decision: finalDecision,
            case_id: args.case_id,
            reasons: finalScores.reasons ?? [],
            medical_reasons: finalScores.medical_reasons ?? [],
            financial_reasons: finalScores.financial_reasons ?? [],
            fraud_reasons: finalScores.fraud_reasons ?? [],
          },
          last_action: {
            toolName: "run_risk_assessment",
            entityType: "case",
            entityId: args.case_id,
            route: results_route,
            label: "Risk assessment complete"
          },
          quick_actions: [
            { label: "View Results", actionType: "navigate", payload: results_route },
            { label: "Move to Review", actionType: "submit", payload: `Move case ${args.case_id} to Under Review` }
          ]
        });
      } catch (err: any) {
        resolveInterrupt({ success: false, message: `Assessment failed: ${err.message}` });
      } finally {
        interruptRiskRef.current = false;
        setRiskSteps([]);
      }
    })();
  }, [pendingInterrupt, resolveInterrupt]);

  const getBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = error => reject(error);
    });
  };

  const handleSubmit = useCallback(async (e?: React.FormEvent, overrideText?: string) => {
    e?.preventDefault();
    const text = overrideText ?? input;
    if ((!text.trim() && !selectedFile) || isLoading || isUploading) return;
    if (!overrideText) setInput("");
    setUploadedDocs([]);

    let attachments = undefined;
    if (selectedFile) {
        try {
            const base64Url = await getBase64(selectedFile);
            attachments = [{ name: selectedFile.name, url: base64Url }];
            setSelectedFile(null);
        } catch (error) {
            console.error("Error converting file to base64", error);
        }
    }

    if (pendingInterrupt?.kind === "clarify") {
      resolveInterrupt(text.trim());
    } else if (pendingInterrupt?.kind === "confirm") {
      const lowerText = text.trim().toLowerCase();
      if (lowerText === "yes" || lowerText === "y") {
        resolveInterrupt(true);
      } else if (lowerText === "no" || lowerText === "n" || lowerText === "cancel") {
        resolveInterrupt(false);
      } else {
        send(text.trim(), attachments);
      }
    } else {
      send(text.trim(), attachments);
    }
  }, [input, isLoading, pendingInterrupt, send, resolveInterrupt, selectedFile]);

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

  const handleDownloadPDF = async (caseId: string) => {
    try {
      const tenantId = localStorage.getItem("tenant_id") || "00000000-0000-0000-0000-000000000001";
      const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8010";
      
      notify("Generating PDF report...", true);
      const listRes = await fetch(`${API_BASE}/assessments?case_id=${caseId}`, {
        headers: { "X-Tenant-Id": tenantId }
      });
      if (!listRes.ok) throw new Error("Failed to fetch assessment list");
      const list = await listRes.json();
      if (!list || list.length === 0) throw new Error("No assessment found for this case");
      
      const a = list[0];
      const detailRes = await fetch(`${API_BASE}/assessments/${a.id}`, {
        headers: { "X-Tenant-Id": tenantId }
      });
      if (!detailRes.ok) throw new Error("Failed to fetch assessment details");
      const detail = await detailRes.json();
      
      const { generateAssessmentPDF } = await import("@/lib/pdf-export");
      await generateAssessmentPDF({
        customer_name: detail.customer_name,
        customer_cnic: detail.customer_cnic,
        case_id: detail.case_id,
        created_at: detail.created_at,
        medical_score: detail.medical_score,
        financial_score: detail.financial_score,
        fraud_probability: detail.fraud_probability,
        composite_risk_score: detail.composite_risk_score,
        ai_decision: detail.ai_decision,
        suggested_loading: detail.suggested_loading,
        reasons: detail.reasons,
        ai_summary: detail.ai_summary,
        product_name: a.product_name,
      });
      notify("✅ PDF downloaded successfully", true);
    } catch (err: any) {
      notify(`⚠️ Could not download PDF: ${err.message}`, false);
    }
  };

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
          .catch(() => { });
      }
    }
    wasLoadingRef.current = isLoading;
  }, [isLoading, messages]);

  const [sessions, setSessions] = useState<{id: string, date: number, title: string, messages: any[], actions: any[]}[]>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem(STORAGE_KEY + "_sessions");
        if (saved) return JSON.parse(saved);
      } catch {}
    }
    return [];
  });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY + "_sessions", JSON.stringify(sessions));
    }
  }, [sessions]);

  const saveCurrentSession = () => {
    if (messages.length <= 1) return;
    const title = messages.find(m => m.role === 'user')?.text || "New Conversation";
    const sessionId = activeSessionId || Date.now().toString();
    setSessions(prev => {
      const filtered = prev.filter(s => s.id !== sessionId);
      return [{
        id: sessionId,
        date: Date.now(),
        title: title.length > 35 ? title.slice(0, 35) + "..." : title,
        messages: [...messages],
        actions: [...turnActions]
      }, ...filtered];
    });
  };

  const handleClearChat = () => {
    saveCurrentSession();
    setActiveSessionId(null);
    clearChat();
    setSuggestedActions([]);
    localStorage.removeItem(STORAGE_KEY + "_suggestions");
  };

  const handleLoadSession = (session: any) => {
    saveCurrentSession();
    setActiveSessionId(session.id);
    loadChat(session.messages, session.actions || []);
  };

  const handleDeleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessions(prev => prev.filter(s => s.id !== id));
    if (activeSessionId === id) {
      handleClearChat();
    }
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

  // Force disable global dark mode while in automation mode so the chat retains its designed theme
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isAutomationMode) {
      const wasDark = document.documentElement.classList.contains("dark");
      if (wasDark) {
        document.documentElement.classList.remove("dark");
        return () => {
          document.documentElement.classList.add("dark");
        };
      }
    }
  }, [isAutomationMode]);

  if (isAutomationMode) {
    return (
      <div className="flex h-full w-full bg-white text-slate-900 font-sans overflow-hidden">
        {/* Hidden File Input */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setSelectedFile(file);
            selectedFileRef.current = file;
            setIsUploading(true);

            if (interruptUploadRef.current) {
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
              const args = pendingUploadRef.current;
              pendingUploadRef.current = null;
              try {
                const result = await uploadDocument(args, file);
                notify(`✅ ${result.message}`, true);
                if (pendingInterrupt) {
                  setUploadedDocs((prev) => [...prev, args.document_type]);
                  // Do NOT resolve the interrupt yet — the user might need to upload multiple
                  // documents. They will click the 'Proceed' button when they are done.
                } else {
                  const msg = `I've uploaded the ${args.document_type}${args.cnic ? ` for CNIC ${args.cnic}` : ""}. What's the next step?`;
                  send(msg);
                }
              } catch (err: any) {
                notify(`⚠️ ${err.message || "Upload failed."}`, false);
              } finally {
                setSelectedFile(null);
                setIsUploading(false);
              }
            } else if (autoSubmitPrompt) {
              handleSubmit(undefined, `Upload ${file.name} as ${autoSubmitPrompt} for this case.`);
              setAutoSubmitPrompt("");
              setIsUploading(false);
            } else {
              setIsUploading(false);
            }
          }}
          className="hidden"
          accept=".pdf,.png,.jpg,.jpeg,.tiff,.bmp"
        />

        {/* Sidebar */}
        <div className="w-[260px] flex-shrink-0 bg-[#0f1115] border-r border-slate-800 flex-col hidden md:flex relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-48 bg-gradient-to-b from-indigo-500/10 to-transparent pointer-events-none" />
          
          <div className="p-5 flex items-center gap-3 font-bold text-lg text-white relative z-10">
             <div className="w-8 h-8 flex items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 shadow-[0_0_15px_rgba(99,102,241,0.4)]">
               <img src="/rizvi.png" alt="Rizviz" className="w-5 h-5 object-contain brightness-0 invert" />
             </div>
             <span className="tracking-wide">Rizviz<span className="text-indigo-400">.ai</span></span>
          </div>
          <div className="px-4 pb-4 mt-2 relative z-10">
            <button onClick={handleClearChat} className="flex items-center gap-3 w-full px-4 py-3 text-sm font-semibold text-slate-200 bg-white/5 hover:bg-white/10 rounded-xl transition-all border border-white/5 shadow-sm">
              <svg className="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4"/></svg>
              New chat
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
            {sessions.length > 0 && (
              <div className="space-y-1">
                {sessions.map(session => (
                  <button
                    key={session.id}
                    onClick={() => handleLoadSession(session)}
                    className={`w-full text-left px-3 py-2.5 rounded-xl transition-colors group flex items-center justify-between ${activeSessionId === session.id ? 'bg-white/10' : 'hover:bg-white/5'}`}
                  >
                    <div className="flex-1 min-w-0 pr-2">
                      <div className="text-[13px] font-medium text-slate-300 truncate group-hover:text-white transition-colors">
                        {session.title}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {new Date(session.date).toLocaleDateString()}
                      </div>
                    </div>
                    <button onClick={(e) => handleDeleteSession(session.id, e)} className="text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all p-1">
                       <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="p-4 mt-auto border-t border-white/5 bg-black/20 relative z-10">
            <button onClick={() => setAutomationMode(false)} className="flex items-center gap-3 w-full px-4 py-2.5 text-sm font-medium text-slate-400 hover:text-white hover:bg-white/5 rounded-xl transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
              Back to Dashboard
            </button>
          </div>
        </div>
        
        {/* Main Chat Area + Right Suggestions Panel */}
        <div className="flex-1 flex flex-row relative h-full min-w-0 min-h-0">
        <div className="flex-1 flex flex-col relative h-full min-w-0 min-h-0 bg-[#fdfdfe]">
           {/* Subtle ambient glowing orbs */}
           <div className="absolute top-[-10%] left-[-5%] w-[500px] h-[500px] bg-indigo-400/10 rounded-full blur-[100px] pointer-events-none" />
           <div className="absolute bottom-[-10%] right-[-5%] w-[400px] h-[400px] bg-fuchsia-400/10 rounded-full blur-[120px] pointer-events-none" />
           
           {/* Chat Header */}
           <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-slate-200/60 bg-white/40 backdrop-blur-md relative z-20">
             <div className="flex items-center gap-3">
               <button onClick={() => setAutomationMode(false)} className="md:hidden p-2 -ml-2 text-slate-600 hover:text-indigo-600 transition-colors">
                 <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
               </button>
               <div className="flex items-center gap-2">
                 <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
                 <span className="font-bold text-sm text-slate-800 tracking-tight">Rizviz Copilot</span>
                 <span className="hidden sm:inline-block px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 text-[10px] font-bold uppercase tracking-widest ml-1 border border-indigo-100">Beta</span>
               </div>
             </div>
             <div className="flex items-center gap-3">
               <button onClick={handleClearChat} className="text-sm font-semibold text-slate-500 hover:text-slate-800 transition-colors flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-slate-100">
                 <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                 <span className="hidden sm:inline">Clear</span>
               </button>
             </div>
           </div>
           
           {/* Messages */}
           <div className="flex-1 overflow-y-auto custom-scrollbar" ref={scrollContainerRef}>
             <div className="w-full">
               {messages.length === 1 && messages[0].id === "1" && messages[0].role === "assistant" ? (
                 <div className="flex flex-col items-center justify-center h-full min-h-[60vh] px-4">
                   <div className="w-full max-w-3xl flex flex-col items-center mt-10">
                     <div className="text-slate-400 font-bold text-xs uppercase tracking-[0.2em] mb-3">Rizviz AI Copilot</div>
                     <h2 className="text-4xl md:text-[50px] font-bold tracking-tight text-center mb-10 bg-clip-text text-transparent bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500 pb-2 leading-tight">
                       How can I help you today?
                     </h2>
                     
                     {/* Input Box - Perplexity style */}
                     <div className="w-full relative shadow-[0_8px_30px_rgb(0,0,0,0.04)] rounded-2xl bg-white/70 backdrop-blur-xl border border-white/60 focus-within:border-indigo-300 focus-within:ring-4 focus-within:ring-indigo-500/10 transition-all duration-300">
                       {selectedFile && (
                         <div className="px-4 pt-4 pb-0 flex items-center gap-2">
                           <div className="relative group overflow-hidden rounded-xl border border-slate-200 bg-slate-50 flex items-center gap-3 p-2 pr-3 min-w-[160px] max-w-[260px]">
                             {selectedFile.type.startsWith("image/") && selectedFileUrl ? (
                               <div className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 bg-slate-200">
                                 <img src={selectedFileUrl} alt="preview" className="w-full h-full object-cover" />
                               </div>
                             ) : (
                               <div className="w-10 h-10 rounded-lg flex-shrink-0 bg-red-100 text-red-500 flex items-center justify-center">
                                 <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                               </div>
                             )}
                             <div className="flex flex-col min-w-0 flex-1">
                               <span className="text-sm font-semibold text-slate-700 truncate">{selectedFile.name}</span>
                               <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">{selectedFile.type.startsWith("image/") ? "Image" : "Document"}</span>
                             </div>
                             <button
                               type="button"
                               onClick={() => setSelectedFile(null)}
                               className="absolute top-1 right-1 p-1 bg-white/80 hover:bg-white rounded-full shadow-sm opacity-0 group-hover:opacity-100 transition-all text-slate-500 hover:text-red-500"
                             >
                               <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                             </button>
                           </div>
                         </div>
                       )}
                       <form onSubmit={handleSubmit} className="flex flex-col w-full">
                         <textarea 
                           rows={1}
                           value={input}
                           onChange={(e) => setInput(e.target.value)}
                           onKeyDown={(e) => {
                             if (e.key === 'Enter' && !e.shiftKey) {
                               e.preventDefault();
                               handleSubmit();
                             }
                           }}
                           placeholder={pendingInterrupt?.kind === "clarify" ? "Type your answer…" : "Ask anything..."}
                           className="w-full max-h-48 px-5 pt-4 pb-2 bg-transparent border-none focus:outline-none focus:ring-0 resize-none text-[16px] text-slate-900 placeholder:text-slate-400"
                           style={{ minHeight: "60px" }}
                         />
                         
                         <div className="flex items-center justify-between px-3 pb-3">
                           <div className="flex items-center gap-2">
                             <button type="button" onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 px-2.5 py-1.5 text-slate-500 hover:bg-slate-100 rounded-lg text-sm font-medium transition-colors">
                               <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4M4 12h16"/></svg>
                               Attach
                             </button>
                           </div>
                           <div className="flex items-center gap-2">
                             <button type="submit" disabled={(!input.trim() && !selectedFile) || isLoading} className="p-2 bg-[#1a1a1a] hover:bg-black text-white rounded-full disabled:bg-slate-100 disabled:text-slate-300 transition-colors flex items-center justify-center h-10 w-10">
                               <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M5 12l7-7 7 7"/></svg>
                             </button>
                           </div>
                         </div>
                       </form>
                     </div>

                     {/* Action Cards */}
                     <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
                       {(turnActions.length > 0
                         ? turnActions
                         : getRecommendedActions(undefined)
                       ).slice(0, 8).map((action, idx) => (
                         <button
                           key={idx}
                           onClick={() => handleQuickAction(action)}
                           className="flex flex-col items-start p-4 bg-white/60 backdrop-blur-sm hover:bg-white border border-white/60 hover:border-indigo-100 hover:shadow-[0_8px_20px_rgb(99,102,241,0.08)] rounded-2xl transition-all text-left group"
                         >
                           <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-1 group-hover:text-indigo-600 transition-colors">
                             {action.actionType === "navigate" ? (
                               <svg className="w-4 h-4 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                             ) : (
                               <svg className="w-4 h-4 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                             )}
                             {action.label}
                           </div>
                           <div className="text-xs text-slate-500 font-medium w-full truncate">
                             {action.payload}
                           </div>
                         </button>
                       ))}
                     </div>
                     
                   </div>
                 </div>
               ) : (
                 <div className="flex flex-col pb-8 pt-8">
                   {messages.map((msg) => (
                     <div key={msg.id} className="w-full px-4 py-4 md:py-6">
                       <div className={`max-w-3xl mx-auto flex gap-4 md:gap-5 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                         
                         {/* Avatar (only for Agent) */}
                         {msg.role !== "user" && (
                           <div className="flex-shrink-0 mt-1">
                             <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-[0_0_12px_rgba(99,102,241,0.3)] flex items-center justify-center p-1.5 ring-2 ring-white">
                               <img src="/rizvi.png" alt="Agent" className="w-full h-full object-contain brightness-0 invert" />
                             </div>
                           </div>
                         )}

                         <div className={`flex-1 min-w-0 flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
                           
                           <div className={`flex flex-col gap-2 ${msg.role === "user" ? "items-end max-w-[85%]" : "items-start w-full"}`}>
                             {msg.role === "user" ? (
                               <>
                                 {msg.text && (
                                   <div className="group/usermsg relative">
                                     <div className="bg-[#f3f4f6] text-slate-900 px-5 py-3 rounded-[24px] rounded-tr-md text-[15px] leading-relaxed whitespace-pre-wrap">
                                       {msg.text}
                                     </div>
                                     <button
                                       type="button"
                                       title="Copy"
                                       onClick={() => navigator.clipboard.writeText(msg.text)}
                                       className="absolute -bottom-6 right-0 p-1 opacity-0 group-hover/usermsg:opacity-100 transition-opacity text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded"
                                     >
                                       <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
                                     </button>
                                   </div>
                                 )}
                                 {msg.attachments && msg.attachments.length > 0 && (
                                   <div className="flex flex-wrap gap-2 justify-end">
                                     {msg.attachments.map((att, idx) => (
                                       <div key={idx} className="flex items-center gap-2.5 p-1 pr-3.5 bg-white border border-slate-200/80 shadow-sm rounded-full max-w-[220px]">
                                         {att.url.startsWith("data:image/") ? (
                                           <div className="w-7 h-7 rounded-full overflow-hidden flex-shrink-0 border border-slate-100">
                                             <img src={att.url} alt={att.name} className="w-full h-full object-cover" />
                                           </div>
                                         ) : (
                                           <div className="w-7 h-7 rounded-full flex-shrink-0 bg-slate-100 text-slate-500 flex items-center justify-center border border-slate-200/50">
                                             <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                                           </div>
                                         )}
                                         <span className="text-[13px] font-medium text-slate-700 truncate">{att.name}</span>
                                       </div>
                                     ))}
                                   </div>
                                 )}
                               </>
                             ) : (
                               <div className="w-full flex flex-col gap-3">
                                 {msg.steps && msg.steps.length > 0 && (
                                   <div className="mb-1 max-w-[85%]">
                                     <ProcessGraph steps={msg.steps} compact={true} />
                                   </div>
                                 )}
                                 <div className="prose prose-slate max-w-none text-[16px] leading-relaxed break-words text-slate-800 w-full copilot-markdown prose-p:font-serif prose-headings:font-serif prose-li:font-serif">
                                   <ReactMarkdown>{msg.text}</ReactMarkdown>
                                 </div>
                                 
                                 {/* AI Message Action Bar (Perplexity Style) */}
                                 <div className="flex items-center justify-between w-full mt-1 pt-1 text-slate-400 max-w-3xl">
                                   <div className="flex items-center gap-3 md:gap-4">
                                     <button type="button" className="p-1 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors" title="Share">
                                       <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"></path></svg>
                                     </button>
                                     <button type="button" className="p-1 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors" title="Download">
                                       <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                                     </button>
                                     <button type="button" title="Copy" onClick={() => navigator.clipboard.writeText(msg.text)} className="p-1 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors">
                                       <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
                                     </button>
                                     <button type="button" className="p-1 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors" title="Rewrite">
                                       <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                                     </button>
                                   </div>
                                   <div className="flex items-center gap-2">
                                     <button type="button" className="p-1 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors" title="Helpful">
                                       <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5"></path></svg>
                                     </button>
                                     <button type="button" className="p-1 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors" title="Unhelpful">
                                       <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.736 3h4.018a2 2 0 01.485.06l3.76.94m-7 10v5a2 2 0 002 2h.096c.5 0 .905-.405.905-.904 0-.715.211-1.413.608-2.008L17 13V4m-7 10h2m5-10h2a2 2 0 012 2v6a2 2 0 01-2 2h-2.5"></path></svg>
                                     </button>
                                     <button type="button" className="p-1 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors" title="More">
                                       <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M5 12h.01M12 12h.01M19 12h.01M6 12a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0z"></path></svg>
                                     </button>
                                   </div>
                                 </div>
                               </div>
                             )}
                           </div>
                           
                           {/* Quick Actions */}
                           {msg.quickActions && msg.quickActions.length > 0 && (
                             <div className={`flex flex-wrap gap-2 mt-4 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                               {msg.quickActions.map((action, idx) => {
                                 let isUploaded = false;
                                 if (action.actionType === "upload" && action.payload) {
                                   try { const p = JSON.parse(action.payload); isUploaded = uploadedDocs.includes(p.document_type); } catch(e) {}
                                 }
                                 return (
                                   <button
                                     key={`${action.actionType}-${action.label}-${idx}`}
                                     onClick={() => handleQuickAction(action)}
                                     className={`px-3 py-1.5 text-[12px] font-bold rounded-full border transition-all flex items-center gap-1.5 shadow-sm active:scale-95 ${
                                       isUploaded ? "bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200"
                                       : action.actionType === "navigate" ? "bg-white hover:bg-slate-50 text-slate-700 border-slate-200 hover:border-indigo-200 hover:text-indigo-700"
                                       : action.actionType === "upload" ? "bg-amber-50 hover:bg-amber-100 text-amber-700 border-amber-200"
                                       : action.actionType === "confirm" ? "bg-violet-50 hover:bg-violet-100 text-violet-700 border-violet-200"
                                       : "bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border-indigo-200"
                                     }`}
                                   >
                                     {isUploaded && <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M20 6L9 17l-5-5" /></svg>}
                                     {isUploaded ? `Uploaded ${action.label.replace('Upload ', '')}` : action.label}
                                   </button>
                                 );
                               })}
                             </div>
                           )}
                         </div>
                       </div>
                     </div>
                   ))}
                   
                   {isLoading && (
                     <div className="w-full px-4 py-6">
                       <div className="max-w-3xl mx-auto flex gap-4 md:gap-6">
                         <div className="flex-shrink-0 mt-1">
                           <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-[0_0_12px_rgba(99,102,241,0.3)] flex items-center justify-center p-1.5 ring-2 ring-white">
                              <img src="/rizvi.png" alt="Agent" className="w-full h-full object-contain brightness-0 invert" />
                           </div>
                         </div>
                         <div className="flex items-center gap-2 pt-2">
                           <span className="w-2 h-2 rounded-full bg-slate-300 animate-pulse" style={{ animationDelay: "0ms" }} />
                           <span className="w-2 h-2 rounded-full bg-slate-300 animate-pulse" style={{ animationDelay: "150ms" }} />
                           <span className="w-2 h-2 rounded-full bg-slate-300 animate-pulse" style={{ animationDelay: "300ms" }} />
                         </div>
                       </div>
                     </div>
                   )}
                   <div ref={messagesEndRef} />
                 </div>
               )}
             </div>
           </div>

           {/* Bottom Input Area for ongoing chat (when not empty state) */}
           {messages.length > 1 || (messages.length === 1 && messages[0].role !== "assistant") ? (
             <div className="w-full px-4 z-20 pb-4 bg-[#fdfdfe]">
               <div className="max-w-3xl mx-auto relative flex flex-col gap-2">
                 
                 {/* Suggestions are now shown in the right panel (below) */}
                 {(() => {
                   const actionsToShow = turnActions.length > 0
                     ? turnActions
                     : (messages[messages.length - 1]?.role === "assistant" 
                         ? getRecommendedActions(messages[messages.length - 1]) 
                         : []);
                   
                   const extraActions = suggestedActions
                     .filter((s) => !actionsToShow.some((a) => a.label === s))
                     .map((s) => ({ label: s, actionType: "submit", payload: s } as QuickAction));
                   
                   const finalActions = [...actionsToShow, ...extraActions];
                   
                   if (finalActions.length === 0) return null;
                   
                   return (
                     <div className="flex flex-wrap gap-2 px-1 pb-1 hidden">
                       {finalActions.slice(0, 5).map((action, idx) => (
                         <button
                           key={`${action.actionType}-${idx}`}
                           onClick={() => handleQuickAction(action)}
                           className="px-3.5 py-1.5 text-xs font-semibold rounded-full bg-white/90 backdrop-blur-md border border-slate-200/80 hover:bg-white hover:border-indigo-300 hover:text-indigo-700 hover:shadow-sm text-slate-700 transition-all flex items-center gap-1.5 shadow-[0_2px_8px_rgb(0,0,0,0.04)]"
                         >
                           {action.actionType === "navigate" ? (
                             <svg className="w-3.5 h-3.5 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                           ) : action.actionType === "upload" ? (
                             <svg className="w-3.5 h-3.5 text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
                           ) : (
                             <svg className="w-3.5 h-3.5 text-violet-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                           )}
                           {action.label}
                         </button>
                       ))}
                     </div>
                   );
                 })()}

                 <div className="w-full relative shadow-[0_8px_30px_rgb(0,0,0,0.06)] rounded-2xl bg-white/70 backdrop-blur-xl border border-white/60 focus-within:border-indigo-300 focus-within:ring-4 focus-within:ring-indigo-500/10 transition-all duration-300">
                   {selectedFile && (
                     <div className="px-4 pt-4 pb-0 flex items-center gap-2">
                       <div className="relative group overflow-hidden rounded-xl border border-slate-200 bg-slate-50 flex items-center gap-3 p-2 pr-3 min-w-[160px] max-w-[260px]">
                         {selectedFile.type.startsWith("image/") && selectedFileUrl ? (
                           <div className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 bg-slate-200">
                             <img src={selectedFileUrl} alt="preview" className="w-full h-full object-cover" />
                           </div>
                         ) : (
                           <div className="w-10 h-10 rounded-lg flex-shrink-0 bg-red-100 text-red-500 flex items-center justify-center">
                             <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                           </div>
                         )}
                         <div className="flex flex-col min-w-0 flex-1">
                           <span className="text-sm font-semibold text-slate-700 truncate">{selectedFile.name}</span>
                           <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">{selectedFile.type.startsWith("image/") ? "Image" : "Document"}</span>
                         </div>
                         <button
                           type="button"
                           onClick={() => setSelectedFile(null)}
                           className="absolute top-1 right-1 p-1 bg-white/80 hover:bg-white rounded-full shadow-sm opacity-0 group-hover:opacity-100 transition-all text-slate-500 hover:text-red-500"
                         >
                           <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                         </button>
                       </div>
                     </div>
                   )}
                   <form onSubmit={handleSubmit} className="flex flex-col w-full">
                     <textarea 
                       rows={1}
                       value={input}
                       onChange={(e) => setInput(e.target.value)}
                       onKeyDown={(e) => {
                         if (e.key === 'Enter' && !e.shiftKey) {
                           e.preventDefault();
                           handleSubmit();
                         }
                       }}
                       placeholder={pendingInterrupt?.kind === "clarify" ? "Type your answer…" : "Ask anything..."}
                       className="w-full max-h-48 px-5 pt-4 pb-2 bg-transparent border-none focus:outline-none focus:ring-0 resize-none text-[16px] text-slate-900 placeholder:text-slate-400"
                       style={{ minHeight: "60px" }}
                     />
                     
                     <div className="flex items-center justify-between px-3 pb-3">
                       <div className="flex items-center gap-1">
                         <button type="button" onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 px-2.5 py-1.5 text-slate-500 hover:bg-slate-100 rounded-lg text-sm font-medium transition-colors">
                           <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4M4 12h16"/></svg>
                           Attach
                         </button>
                       </div>
                       <div className="flex items-center">
                         <button type="submit" disabled={(!input.trim() && !selectedFile) || isLoading} className="p-2 bg-[#1a1a1a] hover:bg-black text-white rounded-full disabled:bg-slate-100 disabled:text-slate-300 transition-colors flex items-center justify-center h-10 w-10">
                           <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M5 12l7-7 7 7"/></svg>
                         </button>
                       </div>
                     </div>
                   </form>
                 </div>
               </div>
             </div>
           ) : null}
        </div>
        </div>
        {/* Right Suggestions Panel */}
        {(() => {
          const actionsToShow = turnActions.length > 0
            ? turnActions
            : (messages[messages.length - 1]?.role === "assistant"
                ? getRecommendedActions(messages[messages.length - 1])
                : []);
          const extraActions = suggestedActions
            .filter((s) => !actionsToShow.some((a) => a.label === s))
            .map((s) => ({ label: s, actionType: "submit", payload: s } as QuickAction));
          const finalActions = [...actionsToShow, ...extraActions];
          if (finalActions.length === 0 || (messages.length <= 1 && messages[0]?.role === "assistant")) return null;
          return (
            <div className="hidden xl:flex flex-col w-[220px] flex-shrink-0 bg-white/60 backdrop-blur-sm border-l border-slate-200/60 h-full overflow-y-auto custom-scrollbar py-5 px-3 gap-1.5">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 px-2 pb-2">Suggested Actions</div>
              {finalActions.slice(0, 8).map((action, idx) => (
                <button
                  key={`rp-${action.actionType}-${idx}`}
                  onClick={() => handleQuickAction(action)}
                  className="w-full text-left px-3 py-2.5 text-[12.5px] font-medium rounded-xl bg-white hover:bg-indigo-50 border border-slate-200/80 hover:border-indigo-200 hover:text-indigo-700 text-slate-700 transition-all shadow-sm flex items-start gap-2.5 group"
                >
                  <span className="mt-0.5 flex-shrink-0">
                    {action.actionType === "navigate" ? (
                      <svg className="w-3.5 h-3.5 text-indigo-400 group-hover:text-indigo-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                    ) : action.actionType === "upload" ? (
                      <svg className="w-3.5 h-3.5 text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
                    ) : (
                      <svg className="w-3.5 h-3.5 text-violet-400 group-hover:text-violet-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                    )}
                  </span>
                  <span className="leading-snug">{action.label}</span>
                </button>
              ))}
            </div>
          );
        })()}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full relative overflow-hidden">
      {/* ── Clean white backdrop ───────────────────────────────────────── */}
      <div className="absolute inset-0 bg-slate-50" />

      {showVoice && <VoiceOverlay onClose={() => setShowVoice(false)} />}

      {/* ── Phone Frame / Desktop Frame ────────────────────────────────────────────────── */}
      <div className={`relative z-10 flex-1 flex flex-col ${isAutomationMode ? "max-w-4xl mx-auto w-full pt-8 pb-4" : "items-center justify-center p-3 sm:p-5"} min-h-0`}>
        <div className={`w-full flex-1 flex flex-col ${isAutomationMode ? "bg-white rounded-2xl shadow-xl border border-slate-200" : "max-w-[420px] bg-slate-900 rounded-[2.75rem] p-2.5 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.6)] ring-1 ring-white/20"} min-h-0 animate-in fade-in zoom-in-95 duration-500`}>
          {/* Screen */}
          <div className={`relative flex-1 flex flex-col bg-white overflow-hidden min-h-0 ${isAutomationMode ? "rounded-2xl" : "rounded-[2.25rem]"}`}>

            {/* ── Status Bar ─────────────────────────────────────────── */}
            {!isAutomationMode && (
              <div className="flex-shrink-0 relative bg-gradient-to-r from-violet-600 to-fuchsia-600 pt-2 pb-1 px-6 flex items-center justify-between text-white text-[11px] font-semibold">
                <span className="tabular-nums">{clock || "9:41"}</span>
                {/* Notch */}
                <div className="absolute left-1/2 -translate-x-1/2 top-1.5 w-24 h-5 bg-slate-900 rounded-full" />
                <div className="flex items-center gap-1.5">
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><rect x="2" y="14" width="3" height="6" rx="1" /><rect x="7" y="10" width="3" height="10" rx="1" /><rect x="12" y="6" width="3" height="14" rx="1" /><rect x="17" y="2" width="3" height="18" rx="1" /></svg>
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 18a2 2 0 100 4 2 2 0 000-4zm0-5c1.7 0 3.3.66 4.5 1.8l-1.4 1.4A4.5 4.5 0 009 16.2l-1.4-1.4A6.4 6.4 0 0112 13zm0-4.5c2.9 0 5.6 1.15 7.6 3.1l-1.4 1.4A9 9 0 006 13.1l-1.4-1.4A10.7 10.7 0 0112 8.5z" /></svg>
                  <svg className="w-6 h-3.5" viewBox="0 0 28 14" fill="none"><rect x="1" y="1" width="22" height="12" rx="3" stroke="currentColor" strokeWidth="1.5" /><rect x="3" y="3" width="16" height="8" rx="1.5" fill="currentColor" /><rect x="24.5" y="4.5" width="2" height="5" rx="1" fill="currentColor" /></svg>
                </div>
              </div>
            )}

            {/* ── Chat Header ────────────────────────────────────────── */}
            <div className="flex-shrink-0 bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 pb-3 pt-1 flex items-center justify-between text-white shadow-lg">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <div className="w-10 h-10 rounded-full bg-white logo-white flex items-center justify-center shadow-md overflow-hidden ring-2 ring-white/40">
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
            <div className="flex-1 overflow-y-auto px-3.5 py-4 relative bg-gradient-to-b from-violet-50 via-white to-fuchsia-50" ref={scrollContainerRef}>
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-[0.04] z-0">
                <img src="/rizvi.png" alt="" className="w-1/2 max-w-[200px] object-contain" />
              </div>
              <div className="relative z-10 space-y-4 pb-2">
                {messages.map((msg) => (
                  <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} items-end gap-2 group animate-in slide-in-from-bottom-2 duration-300`}>
                    {msg.role === "assistant" && (
                      <div className="w-7 h-7 rounded-full bg-white logo-white border border-violet-100 shadow-sm flex flex-shrink-0 items-center justify-center overflow-hidden">
                        <img src="/rizvi.png" alt="Agent" className="w-5 h-5 object-contain" />
                      </div>
                    )}
                    <div className={`max-w-[82%] px-4 py-2.5 text-[14px] leading-relaxed shadow-sm flex flex-col gap-3 ${msg.role === "user"
                        ? "bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white rounded-2xl rounded-br-md"
                        : "bg-white border border-slate-100 text-slate-700 rounded-2xl rounded-bl-md"
                      }`}>
                      {msg.role === "user" ? (
                        <div className="flex flex-col gap-2">
                          <div className="whitespace-pre-wrap">{msg.text}</div>
                          {msg.attachments && msg.attachments.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 justify-end mt-1">
                              {msg.attachments.map((att, idx) => (
                                <div key={idx} className="flex items-center gap-2 p-1 pr-2.5 bg-white/20 backdrop-blur-sm border border-white/30 rounded-full max-w-[200px]">
                                  {att.url.startsWith("data:image/") ? (
                                    <div className="w-5 h-5 rounded-full overflow-hidden flex-shrink-0">
                                      <img src={att.url} alt={att.name} className="w-full h-full object-cover" />
                                    </div>
                                  ) : (
                                    <div className="w-5 h-5 rounded-full flex-shrink-0 bg-white/40 text-white flex items-center justify-center">
                                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                                    </div>
                                  )}
                                  <span className="text-[11px] font-medium text-white truncate">{att.name}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="copilot-markdown">
                          <ReactMarkdown>{msg.text}</ReactMarkdown>
                          {msg.steps && msg.steps.length > 0 && (
                            <div className="mt-4 mb-1">
                              <ProcessGraph steps={msg.steps} compact={true} />
                            </div>
                          )}
                          {msg.assessment && (() => {
                            const aScores = msg.assessment.scores ?? {} as any;
                            const medicalPct = aScores.medical_score || 0;
                            const financialPct = aScores.financial_score || 0;
                            const fraudPct = aScores.fraud_probability ? Math.round(aScores.fraud_probability * 100) : 0;
                            const compositePct = aScores.composite_score || aScores.composite_risk_score || 0;
                            const scoreTier = (s: number) => s <= 25 ? { label: "Low Risk", text: "text-emerald-600", bar: "#22c55e" } : s <= 50 ? { label: "Moderate Risk", text: "text-amber-600", bar: "#f59e0b" } : s <= 75 ? { label: "Elevated Risk", text: "text-orange-500", bar: "#f97316" } : { label: "High Risk", text: "text-red-600", bar: "#ef4444" };
                            const ringColor = (s: number) => s <= 25 ? "border-emerald-500" : s <= 50 ? "border-amber-400" : s <= 75 ? "border-orange-500" : "border-red-500";
                            const dec = msg.assessment.ai_decision || "";
                            const decStyle = dec.toLowerCase().includes("approv") ? { bg: "bg-emerald-50", border: "border-emerald-200", icon: "text-emerald-600", title: "text-emerald-900", desc: "text-emerald-700" }
                              : dec.toLowerCase().includes("review") || dec.toLowerCase().includes("human") ? { bg: "bg-blue-50", border: "border-blue-200", icon: "text-blue-600", title: "text-blue-900", desc: "text-blue-700" }
                              : { bg: "bg-rose-50", border: "border-rose-200", icon: "text-rose-600", title: "text-rose-900", desc: "text-rose-700" };
                            const compTier = scoreTier(compositePct);
                            // Merge all reasons into one list with category tag
                            const allReasons: any[] = [
                              ...(msg.assessment.medical_reasons ?? []).map((r: any) => ({ ...r, _cat: "MEDICAL" })),
                              ...(msg.assessment.financial_reasons ?? []).map((r: any) => ({ ...r, _cat: "FINANCIAL" })),
                              ...(msg.assessment.fraud_reasons ?? []).map((r: any) => ({ ...r, _cat: "FRAUD" })),
                              ...(msg.assessment.reasons ?? []).filter((r: any) => !String(r?.observation || r?.reason || "").includes("->") && !String(r?.observation || r?.reason || "").toLowerCase().includes("composite")),
                            ];
                            const catIcon: Record<string, string> = { MEDICAL: "🩺", FINANCIAL: "💰", FRAUD: "🛡️" };
                            const ratingDot = (rating: string = "") => rating.toLowerCase().includes("high") ? "bg-red-500" : rating.toLowerCase().includes("moderate") || rating.toLowerCase().includes("elevated") ? "bg-amber-400" : "bg-emerald-500";
                            const ratingText = (rating: string = "") => rating.toLowerCase().includes("high") ? "text-red-600" : rating.toLowerCase().includes("moderate") || rating.toLowerCase().includes("elevated") ? "text-amber-600" : "text-emerald-600";
                            return (
                              <div className="mt-4 flex flex-col gap-3 text-[13px]">
                                {/* Block 1: Scores */}
                                <div className="p-4 bg-white border border-slate-200 rounded-xl shadow-sm">
                                  <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4">AI Risk Assessment</div>
                                  <div className="flex flex-col gap-4 mb-5">
                                    {[
                                      { label: "Medical Risk Score", pct: medicalPct },
                                      { label: "Financial Risk Score", pct: financialPct },
                                      { label: "Fraud Risk Score", pct: fraudPct },
                                    ].map(({ label, pct }) => {
                                      const t = scoreTier(pct);
                                      return (
                                        <div key={label}>
                                          <div className="flex justify-between items-center mb-1.5">
                                            <span className="font-semibold text-slate-800">{label}</span>
                                            <span className={`font-semibold ${t.text}`}>{t.label} <span className="font-black text-slate-900 ml-1">{pct}%</span></span>
                                          </div>
                                          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                                            <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, backgroundColor: t.bar }} />
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                  {/* Composite ring */}
                                  <div className="flex items-center gap-5 pt-4 border-t border-slate-100">
                                    <div className={`relative w-20 h-20 rounded-full border-[5px] ${ringColor(compositePct)} flex items-center justify-center flex-shrink-0`}>
                                      <div className="text-center">
                                        <span className="block text-xl font-extrabold text-slate-900 leading-none">{compositePct}<span className="text-sm">%</span></span>
                                      </div>
                                    </div>
                                    <div>
                                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Composite Risk Score</p>
                                      <p className={`text-[15px] font-bold mt-1 ${compTier.text}`}>{compTier.label}</p>
                                    </div>
                                  </div>
                                </div>
                                {/* Block 2: AI Recommendation */}
                                <div className="p-4 bg-white border border-slate-200 rounded-xl shadow-sm">
                                  <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">AI Recommendation</div>
                                  <div className={`p-3 rounded-xl border flex items-start gap-3 ${decStyle.bg} ${decStyle.border}`}>
                                    <svg className={`w-5 h-5 mt-0.5 flex-shrink-0 ${decStyle.icon}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={dec.toLowerCase().includes("approv") ? "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" : "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"} /></svg>
                                    <div>
                                      <div className={`text-[11px] font-black uppercase tracking-wide ${decStyle.title}`}>{dec || "Pending"}</div>
                                      <div className={`text-[11px] mt-0.5 ${decStyle.desc}`}>
                                        {compositePct <= 25 ? "Low composite risk. Eligible for auto-approval." : compositePct <= 50 ? `Composite risk at ${compositePct}. Moderate risk factors detected.` : compositePct <= 75 ? `Composite risk at ${compositePct}. Departmental review required.` : `High composite risk at ${compositePct}. Manual underwriting required.`}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                                {/* Block 3: AI Analysis table (only if reasons available) */}
                                {allReasons.length > 0 && (
                                  <div className="p-4 bg-white border border-slate-200 rounded-xl shadow-sm">
                                    <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">AI Analysis</div>
                                    <div className="overflow-x-auto -mx-1">
                                      <table className="w-full min-w-[420px] text-[11.5px]">
                                        <thead>
                                          <tr className="border-b border-slate-100">
                                            <th className="text-left py-1.5 px-2 font-bold text-[10px] uppercase tracking-widest text-slate-400 w-[90px]">Category</th>
                                            <th className="text-left py-1.5 px-2 font-bold text-[10px] uppercase tracking-widest text-slate-400 w-[110px]">Parameter</th>
                                            <th className="text-left py-1.5 px-2 font-bold text-[10px] uppercase tracking-widest text-slate-400">Observation</th>
                                            <th className="text-left py-1.5 px-2 font-bold text-[10px] uppercase tracking-widest text-slate-400 w-[80px]">Risk</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {allReasons.slice(0, 12).map((r: any, i: number) => {
                                            const cat = r._cat || r.category || "GENERAL";
                                            const param = r.parameter || r.factor || "—";
                                            const obs = r.observation || r.reason || "—";
                                            const rating = r.risk_rating || r.risk_level || "Low";
                                            return (
                                              <tr key={i} className="border-b border-slate-50 hover:bg-slate-50/60 transition-colors">
                                                <td className="py-2 px-2 align-top">
                                                  <span className="font-bold text-slate-600">{catIcon[cat] || "📋"} {cat}</span>
                                                </td>
                                                <td className="py-2 px-2 align-top font-semibold text-slate-800">{param}</td>
                                                <td className="py-2 px-2 align-top text-slate-500 leading-snug">{obs}</td>
                                                <td className="py-2 px-2 align-top">
                                                  <span className={`flex items-center gap-1.5 font-semibold ${ratingText(rating)}`}>
                                                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${ratingDot(rating)}`} />
                                                    {rating}
                                                  </span>
                                                </td>
                                              </tr>
                                            );
                                          })}
                                        </tbody>
                                      </table>
                                    </div>
                                    {/* Download button always at bottom of analysis table */}
                                    {msg.assessment.case_id && (
                                      <div className="flex justify-end mt-3 pt-3 border-t border-slate-100">
                                        <button
                                          onClick={() => handleDownloadPDF(msg.assessment?.case_id as string)}
                                          className="flex items-center gap-2 px-4 py-2 text-[12px] font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl transition-colors shadow-sm"
                                        >
                                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                                          Download PDF Report
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                )}
                                {/* Download button when no reasons table */}
                                {allReasons.length === 0 && msg.assessment.case_id && (
                                  <div className="flex justify-end">
                                    <button
                                      onClick={() => handleDownloadPDF(msg.assessment?.case_id as string)}
                                      className="flex items-center gap-2 px-4 py-2 text-[12px] font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl transition-colors shadow-sm"
                                    >
                                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                                      Download PDF Report
                                    </button>
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      )}
                      {msg.quickActions && msg.quickActions.length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-1">
                          {msg.quickActions.map((action, idx) => {
                            let isUploaded = false;
                            if (action.actionType === "upload" && action.payload) {
                              try {
                                const payload = JSON.parse(action.payload);
                                isUploaded = uploadedDocs.includes(payload.document_type);
                              } catch(e) {}
                            }
                            return (
                            <button
                              key={`${action.actionType}-${action.label}-${idx}`}
                              onClick={() => handleQuickAction(action)}
                              disabled={isLoading || isUploading}
                              className={`px-3 py-1.5 text-[12px] font-bold rounded-full border transition-all flex items-center gap-1.5 shadow-sm active:scale-95 ${
                                (isLoading || isUploading) ? "opacity-60 cursor-not-allowed pointer-events-none " : ""
                              }${
                                isUploaded
                                  ? "bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200"
                                  : action.actionType === "navigate"
                                    ? "bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200"
                                    : action.actionType === "upload"
                                      ? "bg-amber-50 hover:bg-amber-100 text-amber-700 border-amber-200"
                                      : action.actionType === "confirm"
                                        ? "bg-violet-50 hover:bg-violet-100 text-violet-700 border-violet-200"
                                        : "bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border-indigo-200"
                                }`}
                            >
                              {isUploaded ? (
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M20 6L9 17l-5-5" /></svg>
                              ) : action.actionType === "navigate" ? (
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>
                              ) : action.actionType === "upload" ? (
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                              ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><circle cx="12" cy="12" r="10" /><path d="M12 8v8" /></svg>
                              )}
                              {isUploaded ? `Uploaded ${action.label.replace('Upload ', '')}` : action.label}
                            </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {/* Live process graph — the agent narrating its own state
                    machine, node by node, while (and after) it works. */}
                {(steps.length > 0 || riskSteps.length > 0) && (
                  <div className="flex justify-start items-start gap-2">
                    <div className="w-7 h-7 rounded-full bg-white logo-white border border-violet-100 shadow-sm flex flex-shrink-0 items-center justify-center overflow-hidden">
                      <img src="/rizvi.png" alt="Agent" className="w-5 h-5 object-contain" />
                    </div>
                    <div className="max-w-[82%] flex-1">
                      <ProcessGraph steps={riskSteps.length > 0 ? riskSteps : steps} />
                    </div>
                  </div>
                )}
                {isLoading && (
                  <div className="flex justify-start items-end gap-2">
                    <div className="w-7 h-7 rounded-full bg-white logo-white border border-violet-100 shadow-sm flex flex-shrink-0 items-center justify-center overflow-hidden">
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
                  <div className="relative group overflow-hidden rounded-xl border border-slate-200 bg-slate-50 flex items-center gap-3 p-2 pr-3 min-w-[160px] max-w-[260px]">
                    {selectedFile.type.startsWith("image/") && selectedFileUrl ? (
                      <div className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 bg-slate-200">
                        <img src={selectedFileUrl} alt="preview" className="w-full h-full object-cover" />
                      </div>
                    ) : (
                      <div className="w-10 h-10 rounded-lg flex-shrink-0 bg-red-100 text-red-500 flex items-center justify-center">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                      </div>
                    )}
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-sm font-semibold text-slate-700 truncate">{selectedFile.name}</span>
                      <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">{selectedFile.type.startsWith("image/") ? "Image" : "Document"}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedFile(null)}
                      className="absolute top-1 right-1 p-1 bg-white/80 hover:bg-white rounded-full shadow-sm opacity-0 group-hover:opacity-100 transition-all text-slate-500 hover:text-red-500"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
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
                    className="flex-1 bg-transparent text-slate-900 py-1.5 focus:outline-none text-[14px] placeholder:text-slate-400 min-w-0 disabled:opacity-50"
                    disabled={isLoading || isUploading}
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
                <button type="submit" disabled={!input.trim() || isLoading || isUploading}
                  className="p-3 bg-gradient-to-br from-violet-500 to-fuchsia-500 hover:from-violet-600 hover:to-fuchsia-600 disabled:from-slate-300 disabled:to-slate-300 text-white rounded-full transition-all shadow-lg shadow-fuchsia-500/30 active:scale-90 shrink-0">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
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
                      disabled={isLoading || isUploading}
                      className={`text-[10px] px-2.5 py-1 rounded-full font-medium transition-all border ${
                        (isLoading || isUploading) ? "opacity-60 cursor-not-allowed pointer-events-none " : ""
                      }${action.actionType === "navigate"
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
