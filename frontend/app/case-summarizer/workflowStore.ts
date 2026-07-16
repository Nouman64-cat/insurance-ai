import api from "@/app/services/api";

export interface Applicant {
  id: string;
  cnic: string;
  name: string;
  dob: string;
  gender: string;
  occupation: string;
  declared_income: number;
}

export interface CaseItem {
  caseld: string;
  caseNumber: string;
  status: string;
}

export interface Artifact {
  id: string;
  file_name: string | null;
  document_type: string;
  status: string;
  ocr_result: string | null;
}

export interface TokenUsage { input: number; output: number; total: number }

export type SumStatus  = "idle" | "streaming" | "done" | "error";
export type EvalStatus = "idle" | "streaming" | "done" | "error";

export interface EvalState {
  completedNodes:   string[];
  medicalScore:     number | null;
  medicalReasons:   string[];
  financialScore:     number | null;
  financialReasons:   string[];
  fraudProbability: number | null;
  fraudReasons:     string[];
  compositeScore:   number | null;
  aiDecision:       string | null;
  reasons:          string[];
  validationErrors: string[];
}

export interface EvalForm {
  cnic: string;
  name: string;
  dob: string;
  gender: string;
  occupation: string;
  declaredIncome: string;
  productName: string;
  coverageAmount: string;
  termYears: string;
}

export const INITIAL_EVAL: EvalState = {
  completedNodes: [], medicalScore: null, medicalReasons: [],
  financialScore: null, financialReasons: [], fraudProbability: null,
  fraudReasons: [], compositeScore: null, aiDecision: null,
  reasons: [], validationErrors: [],
};

export const INITIAL_FORM: EvalForm = {
  cnic: "", name: "", dob: "", gender: "Male", occupation: "",
  declaredIncome: "", productName: "Term Life Insurance", coverageAmount: "", termYears: "",
};

type Listener = () => void;

export interface WorkflowStoreType {
  selectedApplicant: Applicant | null;
  selectedCase: CaseItem | null;
  checkedDocs: Set<string>;
  applicantSearch: string;
  sumStatus: SumStatus;
  summary: string;
  tokenUsage: TokenUsage | null;
  sumError: string | null;
  showEvalForm: boolean;
  evalForm: EvalForm;
  evalStatus: EvalStatus;
  evalResult: EvalState;
  evalError: string | null;
  sumAbort: AbortController | null;
  evalAbort: AbortController | null;
  subscribe(listener: Listener): () => void;
  notify(): void;
  update(updates: Partial<Omit<WorkflowStoreType, "subscribe" | "notify" | "update" | "reset" | "startSummarize" | "startEval">>): void;
  reset(): void;
  startSummarize(apiBase: string, jwtToken: string, selectedDocs: Artifact[]): Promise<void>;
  startEval(apiBase: string, tenantId: string): Promise<void>;
}

const listeners = new Set<Listener>();

export const workflowStore: WorkflowStoreType = {
  // Selection
  selectedApplicant: null,
  selectedCase: null,
  checkedDocs: new Set<string>(),
  applicantSearch: "",
  
  // Summary
  sumStatus: "idle",
  summary: "",
  tokenUsage: null,
  sumError: null,
  
  // Form State
  showEvalForm: false,
  evalForm: { ...INITIAL_FORM },
  
  // Evaluation
  evalStatus: "idle",
  evalResult: { ...INITIAL_EVAL },
  evalError: null,

  // Abort Controllers
  sumAbort: null,
  evalAbort: null,

  // Subscriptions
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  notify() {
    listeners.forEach(l => l());
  },

  update(updates) {
    Object.assign(this, updates);
    this.notify();
  },

  reset() {
    this.sumAbort?.abort();
    this.evalAbort?.abort();
    this.selectedApplicant = null;
    this.selectedCase = null;
    this.checkedDocs = new Set<string>();
    this.applicantSearch = "";
    this.sumStatus = "idle";
    this.summary = "";
    this.tokenUsage = null;
    this.sumError = null;
    this.showEvalForm = false;
    this.evalForm = { ...INITIAL_FORM };
    this.evalStatus = "idle";
    this.evalResult = { ...INITIAL_EVAL };
    this.evalError = null;
    this.notify();
  },

  async startSummarize(apiBase: string, jwtToken: string, selectedDocs: Artifact[]) {
    if (selectedDocs.length === 0) return;
    this.sumAbort?.abort();
    const abort = new AbortController();
    this.sumAbort = abort;

    this.update({
      sumStatus: "streaming",
      summary: "",
      tokenUsage: null,
      sumError: null,
      evalStatus: "idle",
      evalResult: { ...INITIAL_EVAL },
      evalError: null
    });

    try {
      const res = await fetch(`${apiBase}/summarize/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${jwtToken}`,
        },
        body: JSON.stringify({ documents: selectedDocs.map(d => d.ocr_result!) }),
        signal: abort.signal,
      });

      if (!res.ok) throw new Error(`Summarizer returned ${res.status}`);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data: ")) continue;
          let evt: Record<string, any>;
          try { evt = JSON.parse(line.slice(6)); } catch { continue; }
          if (evt.type === "chunk") {
            this.summary += evt.text as string;
            this.notify();
          } else if (evt.type === "done") {
            this.update({
              tokenUsage: evt.token_usage as TokenUsage,
              sumStatus: "done"
            });
          } else if (evt.type === "error") {
            this.update({
              sumError: (evt.message as string) ?? "Unknown error",
              sumStatus: "error"
            });
          }
        }
      }
    } catch (err: any) {
      if (err instanceof Error && err.name === "AbortError") return;
      this.update({
        sumError: err instanceof Error ? err.message : "Connection failed",
        sumStatus: "error"
      });
    }
  },

  async startEval(apiBase: string, tenantId: string) {
    this.evalAbort?.abort();
    const abort = new AbortController();
    this.evalAbort = abort;

    this.update({
      evalStatus: "streaming",
      evalResult: { ...INITIAL_EVAL },
      evalError: null
    });

    const payload = {
      applicant: {
        cnic: this.evalForm.cnic, name: this.evalForm.name, dob: this.evalForm.dob,
        gender: this.evalForm.gender, occupation: this.evalForm.occupation,
        declared_income: parseFloat(this.evalForm.declaredIncome) || 0,
      },
      policy: {
        product_name: this.evalForm.productName,
        coverage_amount: parseFloat(this.evalForm.coverageAmount) || 0,
        term_years: parseInt(this.evalForm.termYears) || 0,
      },
      ...(this.selectedCase?.caseld ? { case_id: this.selectedCase.caseld } : {}),
      ...(this.summary ? { ai_summary: this.summary } : {}),
    };

    try {
      const res = await fetch(`${apiBase}/evaluate/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Tenant-Id": tenantId },
        body: JSON.stringify(payload),
        signal: abort.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          Array.isArray(body.detail)
            ? body.detail.map((d: { msg?: string }) => d.msg ?? d).join(", ")
            : body.detail ?? `Error ${res.status}`,
        );
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data: ")) continue;
          let evt: Record<string, any>;
          try { evt = JSON.parse(line.slice(6)); } catch { continue; }
          const type = evt.type as string;
          if (type === "progress") {
            const node = evt.node as string;
            const data = evt.data as Record<string, any>;
            
            const prev = this.evalResult;
            const next: EvalState = {
              ...prev,
              completedNodes: prev.completedNodes.includes(node)
                ? prev.completedNodes : [...prev.completedNodes, node],
            };
            if (node === "medical_scoring") {
              next.medicalScore   = data.medical_score   as number;
              next.medicalReasons = (data.medical_reasons as string[]) ?? [];
            } else if (node === "financial_scoring") {
              next.financialScore   = data.financial_score   as number;
              next.financialReasons = (data.financial_reasons as string[]) ?? [];
            } else if (node === "fraud_detection") {
              next.fraudProbability = data.fraud_probability as number;
              next.fraudReasons     = (data.fraud_reasons as string[]) ?? [];
            } else if (node === "decision_aggregation") {
              next.compositeScore = data.composite_risk_score as number;
              next.aiDecision     = data.ai_decision as string;
              next.reasons        = (data.reasons as string[]) ?? [];
            }
            this.evalResult = next;
            this.notify();

            if (node === "decision_aggregation") {
              this.update({ evalStatus: "done" });
            }
          } else if (type === "invalid") {
            this.update({
              evalResult: { ...this.evalResult, validationErrors: (evt.errors as string[]) ?? [] },
              evalStatus: "error",
              evalError: "Validation failed — see errors below."
            });
            break outer;
          } else if (type === "error") {
            this.update({
              evalStatus: "error",
              evalError: (evt.message as string) ?? "Unexpected error."
            });
            break outer;
          }
        }
      }
    } catch (err: any) {
      if (err instanceof Error && err.name === "AbortError") return;
      this.update({
        evalStatus: "error",
        evalError: err instanceof Error ? err.message : "Connection failed."
      });
    }
  }
};
