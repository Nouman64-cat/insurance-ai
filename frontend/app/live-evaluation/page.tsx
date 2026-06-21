"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { RiskScoreBar, CompositeScoreRing } from "@/components/RiskScoreBar";
import { StatusBadge } from "@/components/StatusBadge";
import type { AIDecision } from "@/lib/mock-data";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8010";

// ── Types ─────────────────────────────────────────────────────────────────────

type StreamStatus = "idle" | "streaming" | "done" | "error";

interface FormValues {
  tenantId:       string;
  cnic:           string;
  name:           string;
  dob:            string;
  gender:         string;
  occupation:     string;
  declaredIncome: string;
  productName:    string;
  coverageAmount: string;
  termYears:      string;
}

interface EvalState {
  completedNodes:   string[];
  medicalScore:     number | null;
  medicalReasons:   string[];
  financialScore:   number | null;
  financialReasons: string[];
  fraudProbability: number | null;
  fraudReasons:     string[];
  compositeScore:   number | null;
  aiDecision:       string | null;
  reasons:          string[];
  validationErrors: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PIPELINE_NODES = [
  { key: "validate_input",       label: "Input\nValidation",    dotColor: "bg-slate-500"   },
  { key: "medical_scoring",      label: "Medical\nScoring",     dotColor: "bg-blue-500"    },
  { key: "financial_scoring",    label: "Financial\nScoring",   dotColor: "bg-violet-500"  },
  { key: "fraud_detection",      label: "Fraud\nDetection",     dotColor: "bg-red-500"     },
  { key: "decision_aggregation", label: "Decision\nAggregation",dotColor: "bg-emerald-500" },
] as const;

const INITIAL_EVAL: EvalState = {
  completedNodes:   [],
  medicalScore:     null,
  medicalReasons:   [],
  financialScore:   null,
  financialReasons: [],
  fraudProbability: null,
  fraudReasons:     [],
  compositeScore:   null,
  aiDecision:       null,
  reasons:          [],
  validationErrors: [],
};

const DEFAULT_FORM: FormValues = {
  tenantId:       process.env.NEXT_PUBLIC_TENANT_ID ?? "",
  cnic:           "",
  name:           "",
  dob:            "",
  gender:         "Male",
  occupation:     "",
  declaredIncome: "",
  productName:    "Term Life Insurance",
  coverageAmount: "",
  termYears:      "",
};

const VALID_DECISIONS = new Set<string>(["Auto Approve", "Approve with Loading", "Human Review", "Decline"]);
function asDecision(v: string | null): AIDecision | null {
  return v && VALID_DECISIONS.has(v) ? (v as AIDecision) : null;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LiveEvaluationPage() {
  const [form,   setForm]   = useState<FormValues>(DEFAULT_FORM);
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [result, setResult] = useState<EvalState>(INITIAL_EVAL);
  const [error,  setError]  = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight request when the component unmounts
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const setField = useCallback(
    (key: keyof FormValues, val: string) => setForm(f => ({ ...f, [key]: val })),
    [],
  );

  // ── Stream handler ───────────────────────────────────────────────────────────

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setStatus("streaming");
    setResult(INITIAL_EVAL);
    setError(null);

    const payload = {
      applicant: {
        cnic:            form.cnic,
        name:            form.name,
        dob:             form.dob,
        gender:          form.gender,
        occupation:      form.occupation,
        declared_income: parseFloat(form.declaredIncome) || 0,
      },
      policy: {
        product_name:    form.productName,
        coverage_amount: parseFloat(form.coverageAmount) || 0,
        term_years:      parseInt(form.termYears)         || 0,
      },
    };

    try {
      const res = await fetch(`${API_BASE}/evaluate/stream`, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tenant-Id":  form.tenantId,
        },
        body:   JSON.stringify(payload),
        signal: abort.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          Array.isArray(body.detail)
            ? body.detail.map((d: { msg?: string }) => d.msg ?? d).join(", ")
            : body.detail ?? `Gateway returned ${res.status}`,
        );
      }

      const reader  = res.body!.getReader();
      const decoder = new TextDecoder();
      let   buffer  = "";

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data: ")) continue;

          let evt: Record<string, unknown>;
          try { evt = JSON.parse(line.slice(6)); }
          catch { continue; }

          const type = evt.type as string;

          if (type === "progress") {
            const node = evt.node as string;
            const data = evt.data  as Record<string, unknown>;

            setResult(prev => {
              const next: EvalState = {
                ...prev,
                completedNodes: prev.completedNodes.includes(node)
                  ? prev.completedNodes
                  : [...prev.completedNodes, node],
              };
              if (node === "medical_scoring") {
                next.medicalScore   = (data.medical_score   as number)   ?? null;
                next.medicalReasons = (data.medical_reasons as string[]) ?? [];
              } else if (node === "financial_scoring") {
                next.financialScore   = (data.financial_score   as number)   ?? null;
                next.financialReasons = (data.financial_reasons as string[]) ?? [];
              } else if (node === "fraud_detection") {
                next.fraudProbability = (data.fraud_probability as number)   ?? null;
                next.fraudReasons     = (data.fraud_reasons     as string[]) ?? [];
              } else if (node === "decision_aggregation") {
                next.compositeScore = (data.composite_risk_score as number)   ?? null;
                next.aiDecision     = (data.ai_decision          as string)   ?? null;
                next.reasons        = (data.reasons              as string[]) ?? [];
              }
              return next;
            });

            if (node === "decision_aggregation") setStatus("done");

          } else if (type === "invalid") {
            setResult(prev => ({ ...prev, validationErrors: (evt.errors as string[]) ?? [] }));
            setStatus("error");
            setError("Validation failed — see errors below.");
            break outer;

          } else if (type === "error") {
            setStatus("error");
            setError((evt.message as string) ?? "An unexpected error occurred.");
            break outer;

          }
          // "saved" → DB write confirmed; results already displayed via progress events
        }
      }

    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      setStatus("error");
      setError(err instanceof Error ? err.message : "Connection failed.");
    }
  };

  const isRunning = status === "streaming";
  const decision  = asDecision(result.aiDecision);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="px-6 py-5 max-w-screen-2xl mx-auto w-full space-y-5">

      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Live Evaluation</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Submit a proposal and watch the LangGraph nodes fire in real-time via SSE stream.
          </p>
        </div>
        <span className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold tracking-wide">
          POST /evaluate/stream
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-5 items-start">

        {/* ── LEFT — Form ───────────────────────────────────────────────────── */}
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden"
        >
          <div className="px-5 py-3 border-b border-slate-100">
            <p className="text-sm font-semibold text-slate-700">Proposal Form</p>
            <p className="text-xs text-slate-400 mt-0.5">Fields forwarded directly to the Risk Engine</p>
          </div>

          <div className="p-5 space-y-5">

            {/* Tenant ID */}
            <InputField
              label="Tenant ID"
              placeholder="Paste your X-Tenant-Id UUID"
              value={form.tenantId}
              onChange={v => setField("tenantId", v)}
              mono
            />

            {/* Applicant */}
            <section>
              <SectionLabel>Applicant</SectionLabel>
              <div className="space-y-3">
                <InputField label="CNIC"            placeholder="35201-1234567-1"   value={form.cnic}           onChange={v => setField("cnic", v)} />
                <InputField label="Full Name"        placeholder="Muhammad Ali Khan" value={form.name}           onChange={v => setField("name", v)} />
                <InputField label="Date of Birth"    type="date"                    value={form.dob}            onChange={v => setField("dob", v)} />
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Gender</label>
                  <select
                    value={form.gender}
                    onChange={e => setField("gender", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
                  >
                    <option>Male</option>
                    <option>Female</option>
                    <option>Other</option>
                  </select>
                </div>
                <InputField label="Occupation"        placeholder="Software Engineer" value={form.occupation}      onChange={v => setField("occupation", v)} />
                <InputField label="Annual Income (PKR)" type="number" placeholder="1200000" value={form.declaredIncome} onChange={v => setField("declaredIncome", v)} />
              </div>
            </section>

            {/* Policy */}
            <section>
              <SectionLabel>Policy</SectionLabel>
              <div className="space-y-3">
                <InputField label="Product Name"          placeholder="Term Life Insurance" value={form.productName}    onChange={v => setField("productName", v)} />
                <InputField label="Coverage Amount (PKR)" type="number" placeholder="5000000" value={form.coverageAmount} onChange={v => setField("coverageAmount", v)} />
                <InputField label="Term (Years)"           type="number" placeholder="20"      value={form.termYears}     onChange={v => setField("termYears", v)} />
              </div>
            </section>
          </div>

          <div className="px-5 py-4 border-t border-slate-100">
            <button
              type="submit"
              disabled={isRunning}
              className={`w-full py-2.5 rounded-lg text-sm font-semibold transition-all ${
                isRunning
                  ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                  : "bg-slate-900 text-white hover:bg-slate-800 active:scale-[0.99]"
              }`}
            >
              {isRunning ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-slate-400 border-t-transparent animate-spin" />
                  Evaluating…
                </span>
              ) : "Run Evaluation"}
            </button>
          </div>
        </form>

        {/* ── RIGHT — Live results ───────────────────────────────────────────── */}
        <div className="space-y-4">

          {/* Pipeline stepper */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-700">LangGraph Pipeline</p>
              {isRunning && (
                <span className="flex items-center gap-1.5 text-[10px] font-semibold text-blue-600">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                  Streaming
                </span>
              )}
              {status === "done" && (
                <span className="text-[10px] font-semibold text-emerald-600 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  Complete
                </span>
              )}
            </div>

            <div className="px-5 py-5">
              <div className="flex items-start">
                {PIPELINE_NODES.map((node, i) => {
                  const done   = result.completedNodes.includes(node.key);
                  const active = isRunning && i === result.completedNodes.length;
                  return (
                    <div key={node.key} className="flex items-start flex-1 last:flex-none">
                      {/* Step dot + label */}
                      <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-500 ${
                          done   ? `${node.dotColor} text-white shadow-sm`
                          : active ? "bg-blue-50 text-blue-600 border-2 border-blue-400 animate-pulse"
                          :          "bg-slate-100 text-slate-400"
                        }`}>
                          {done ? "✓" : i + 1}
                        </div>
                        <span className="text-[9px] font-medium text-slate-500 text-center leading-tight w-14 whitespace-pre-line">
                          {node.label}
                        </span>
                      </div>
                      {/* Connector line */}
                      {i < PIPELINE_NODES.length - 1 && (
                        <div className={`flex-1 h-0.5 mt-4 mx-0.5 transition-colors duration-500 ${
                          done ? "bg-slate-300" : "bg-slate-100"
                        }`} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Validation errors */}
          {result.validationErrors.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-xs font-bold text-red-700 uppercase tracking-widest mb-2">
                Validation Errors
              </p>
              <ul className="space-y-1">
                {result.validationErrors.map((msg, i) => (
                  <li key={i} className="text-xs text-red-600 flex items-start gap-1.5">
                    <span className="text-red-400 mt-0.5 flex-shrink-0">✕</span>
                    {msg}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Stream / connection error */}
          {status === "error" && error && result.validationErrors.length === 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-xs font-bold text-red-700 uppercase tracking-widest mb-1">Error</p>
              <p className="text-xs text-red-600">{error}</p>
            </div>
          )}

          {/* Score bars — render as each node completes */}
          {(result.medicalScore !== null || result.financialScore !== null || result.fraudProbability !== null) && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100">
                <p className="text-sm font-semibold text-slate-700">Risk Scores</p>
              </div>
              <div className="p-5 space-y-5">

                {result.medicalScore !== null && (
                  <div>
                    <RiskScoreBar label="Medical Score" score={result.medicalScore} />
                    <ReasonList reasons={result.medicalReasons} accent="text-blue-400" />
                  </div>
                )}

                {result.financialScore !== null && (
                  <div>
                    <RiskScoreBar label="Financial Score" score={result.financialScore} />
                    <ReasonList reasons={result.financialReasons} accent="text-violet-400" />
                  </div>
                )}

                {result.fraudProbability !== null && (
                  <div>
                    <RiskScoreBar
                      label="Fraud Probability"
                      score={Math.round(result.fraudProbability * 100)}
                      valueLabel={result.fraudProbability.toFixed(2)}
                    />
                    <ReasonList reasons={result.fraudReasons} accent="text-red-400" />
                  </div>
                )}

              </div>
            </div>
          )}

          {/* Decision panel — appears when decision_aggregation completes */}
          {result.compositeScore !== null && decision && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100">
                <p className="text-sm font-semibold text-slate-700">Underwriting Decision</p>
              </div>
              <div className="p-5 space-y-5">

                {/* Score ring + decision badge */}
                <div className="flex flex-col sm:flex-row sm:items-center gap-5">
                  <CompositeScoreRing score={result.compositeScore} />
                  <div className="space-y-2">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">
                      AI Decision
                    </p>
                    <StatusBadge decision={decision} size="lg" />
                  </div>
                </div>

                {/* XAI reasons */}
                {result.reasons.length > 0 && (
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">
                      XAI Reasons
                    </p>
                    <ul className="space-y-1.5">
                      {result.reasons.map((r, i) => {
                        const isMath = i === result.reasons.length - 1;
                        return (
                          <li
                            key={i}
                            className={`text-xs flex items-start gap-2 ${
                              isMath
                                ? "bg-slate-50 rounded-lg p-2.5 text-slate-700 font-medium font-mono"
                                : "text-slate-600"
                            }`}
                          >
                            <span className={`mt-0.5 flex-shrink-0 ${isMath ? "text-slate-400" : "text-slate-300"}`}>
                              {isMath ? "∑" : "–"}
                            </span>
                            {r}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

              </div>
            </div>
          )}

          {/* Idle placeholder */}
          {status === "idle" && (
            <div className="bg-white rounded-xl border border-slate-200 border-dashed p-12 flex flex-col items-center justify-center text-center">
              <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-3">
                <span className="text-2xl">⚡</span>
              </div>
              <p className="text-sm font-semibold text-slate-600">Ready to evaluate</p>
              <p className="text-xs text-slate-400 mt-1.5 max-w-xs leading-relaxed">
                Fill in the proposal form and click <strong>Run Evaluation</strong>.
                Scores will appear here in real-time as each LangGraph node completes.
              </p>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3">
      {children}
    </p>
  );
}

function InputField({
  label, type = "text", placeholder, value, onChange, mono = false,
}: {
  label:       string;
  type?:       string;
  placeholder?: string;
  value:       string;
  onChange:    (v: string) => void;
  mono?:       boolean;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <input
        type={type}
        required
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`w-full px-3 py-2 text-sm border border-slate-200 rounded-lg
          focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400
          ${mono ? "font-mono" : ""}`}
      />
    </div>
  );
}

function ReasonList({ reasons, accent }: { reasons: string[]; accent: string }) {
  if (!reasons.length) return null;
  return (
    <ul className="mt-2 space-y-1 pl-1">
      {reasons.map((r, i) => (
        <li key={i} className="text-xs text-slate-500 flex items-start gap-1.5">
          <span className={`mt-0.5 flex-shrink-0 ${accent}`}>›</span>
          {r}
        </li>
      ))}
    </ul>
  );
}
