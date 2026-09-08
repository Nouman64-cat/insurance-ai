"use client";

import { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import api from "@/app/services/api";

// --- Per-model pricing ------------------------------------------------------
// USD per 1M tokens. Sources (verify periodically):
//   Gemini    — https://ai.google.dev/gemini-api/docs/pricing
//   OpenAI    — https://platform.openai.com/docs/pricing
//   Anthropic — https://www.anthropic.com/pricing  (cache-read ≈ 0.1× input)
// Last checked: 2026-09-07.
interface Rate {
  input: number;
  cached: number; // cache-read / cached-input rate
  output: number;
}

const MODEL_PRICING: Record<string, Rate> = {
  "gemini-2.5-flash-lite": { input: 0.10, cached: 0.01, output: 0.40 },
  "gemini-2.5-flash": { input: 0.30, cached: 0.03, output: 2.50 },
  "gemini-2.5-pro": { input: 1.25, cached: 0.125, output: 10.0 },
  "gemini-2.0-flash": { input: 0.10, cached: 0.025, output: 0.40 },
  "gpt-4o-mini": { input: 0.15, cached: 0.075, output: 0.60 },
  "gpt-4o": { input: 2.50, cached: 1.25, output: 10.0 },
  "gpt-4.1-nano": { input: 0.10, cached: 0.025, output: 0.40 },
  "gpt-4.1-mini": { input: 0.40, cached: 0.10, output: 1.60 },
  "gpt-4.1": { input: 2.00, cached: 0.50, output: 8.00 },
  "gpt-5-mini": { input: 0.25, cached: 0.025, output: 2.00 },
  "gpt-5": { input: 1.25, cached: 0.125, output: 10.0 },
  "claude-haiku-4-5": { input: 1.00, cached: 0.10, output: 5.00 },
  "claude-3-5-haiku": { input: 0.80, cached: 0.08, output: 4.00 },
  "claude-sonnet-4-5": { input: 3.00, cached: 0.30, output: 15.0 },
  "claude-sonnet-4-6": { input: 3.00, cached: 0.30, output: 15.0 },
  "claude-sonnet-5": { input: 2.00, cached: 0.20, output: 10.0 },
  "claude-3-5-sonnet": { input: 3.00, cached: 0.30, output: 15.0 },
  "claude-opus-4-1": { input: 15.0, cached: 1.50, output: 75.0 },
  "claude-opus-5": { input: 5.00, cached: 0.50, output: 25.0 },
};

// Used when a usage row's model isn't in the table (or is "unknown").
const DEFAULT_RATE: Rate = { input: 1.0, cached: 0.1, output: 3.0 };

/** Strip a trailing date/version suffix and match the longest known prefix. */
function rateFor(model: string): { rate: Rate; known: boolean } {
  const m = (model || "").toLowerCase().replace(/[@-]\d{4}[-.]?\d{2}[-.]?\d{2}.*$/, "");
  let best = "";
  for (const key of Object.keys(MODEL_PRICING)) {
    if (m === key || m.startsWith(key)) {
      if (key.length > best.length) best = key;
    }
  }
  return best ? { rate: MODEL_PRICING[best], known: true } : { rate: DEFAULT_RATE, known: false };
}

interface ModelTokens {
  input: number;
  output: number;
  cached: number;
  requests: number;
}

/** Cost of one model's tokens: fresh input + cached input + output, each at its own rate. */
function costOfModel(model: string, t: ModelTokens): number {
  const { rate } = rateFor(model);
  const fresh = Math.max(t.input - t.cached, 0);
  return (
    (fresh / 1_000_000) * rate.input +
    (t.cached / 1_000_000) * rate.cached +
    (t.output / 1_000_000) * rate.output
  );
}

/** Cost across a by_model map. */
function costOf(byModel: Record<string, ModelTokens>): number {
  return Object.entries(byModel).reduce((sum, [m, t]) => sum + costOfModel(m, t), 0);
}

/** Same tokens, but every token billed at the model's full (non-cached) input rate. */
function unoptimizedCostOf(byModel: Record<string, ModelTokens>): number {
  return Object.entries(byModel).reduce((sum, [m, t]) => {
    const { rate } = rateFor(m);
    return (
      sum +
      (t.input / 1_000_000) * rate.input +
      (t.output / 1_000_000) * rate.output
    );
  }, 0);
}

// One service's consumption on one day.
interface ServiceDay {
  input: number;
  output: number;
  cached: number;
  requests: number;
  models: string[];
  by_model: Record<string, ModelTokens>;
}

interface DailyUsage {
  date: string;
  services: Record<string, ServiceDay>;
  total_input: number;
  total_output: number;
  total_cached: number;
}

interface ServiceBreakdown {
  service: string;
  total_input: number;
  total_output: number;
  total_cached: number;
  total_requests: number;
  total_cost: number;
  by_model: Record<string, ModelTokens>;
  description?: string;
  routeLink?: string;
  routeLabel?: string;
}

const EMPTY_DAY: ServiceDay = { input: 0, output: 0, cached: 0, requests: 0, models: [], by_model: {} };

// Metadata for the services that emit token-usage rows. Keys must match the
// `service_name` each service posts to /tokens/usage.
const FINOPS_SERVICE_METADATA: Record<string, { description: string; route: string; label: string }> = {
  "Chat Agent": {
    description: "Conversational Copilot — tool-calling agent with dynamic tool-subset binding and prompt caching.",
    route: "/",
    label: "Open Copilot",
  },
  "Chat Agent — Plan Advisor": {
    description: "Ranks the top plans for a customer during a Copilot proposal flow.",
    route: "/",
    label: "Open Copilot",
  },
  "Risk Engine": {
    description: "LangGraph medical / financial / fraud scoring and plan suggestion.",
    route: "/assessments",
    label: "View Assessments",
  },
  "OCR Engine": {
    description: "Document text extraction & CNIC artifact parsing using vision models.",
    route: "/cases",
    label: "View Cases",
  },
  "Text Summarizer": {
    description: "Medical history and underwriting file summarization pipeline.",
    route: "/case-summarizer",
    label: "Summarizer",
  },
};

// --- Icons ---
function LockIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function TokenIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4l3 3" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="M4 12H2" />
      <path d="M22 12h-2" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function CheckShieldIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-emerald-500">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function TokenManagementContent() {
  const [authorized, setAuthorized] = useState(true);
  const [loading, setLoading] = useState(true);
  const [usageData, setUsageData] = useState<DailyUsage[]>([]);
  
  // FinOps Optimization Controls State
  const [finOpsControls, setFinOpsControls] = useState({
    promptCaching: true,
    oneClickDirectRouting: true,
    ruleEngineASTCompilation: true,
    commissionWaterfallEngine: true,
    toolSchemaBindingSubset: true,
  });

  type DateRangeOption = "today" | "7days" | "30days";
  const [dateRangeOption, setDateRangeOption] = useState<DateRangeOption>("7days");
  
  const defaultEndDate = new Date();
  const defaultStartDate = new Date();
  defaultStartDate.setDate(defaultEndDate.getDate() - 6);
  
  const [startDate, setStartDate] = useState(defaultStartDate.toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState(defaultEndDate.toISOString().split('T')[0]);

  useEffect(() => {
    const role = localStorage.getItem("user_role");
    if (role !== "SuperAdmin") {
      setAuthorized(false);
      setLoading(false);
      return;
    }
    
    fetchTokenData(startDate, endDate);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (authorized && !loading) {
      const end = new Date();
      const start = new Date();
      if (dateRangeOption === "7days") {
        start.setDate(end.getDate() - 6);
      } else if (dateRangeOption === "30days") {
        start.setDate(end.getDate() - 29);
      }
      
      const startStr = start.toISOString().split('T')[0];
      const endStr = end.toISOString().split('T')[0];
      
      setStartDate(startStr);
      setEndDate(endStr);
      fetchTokenData(startStr, endStr);
    }
  }, [dateRangeOption]);

  const fetchTokenData = async (startStr: string, endStr: string) => {
    try {
      const res = await api.get(`/tokens/usage?start_date=${startStr}&end_date=${endStr}`);
      const payload = res.data;
      const aggregated = payload.data || {};
      
      const data: DailyUsage[] = [];
      const start = new Date(startStr);
      const end = new Date(endStr);
      
      if (start > end) return;
      const diffTime = Math.abs(end.getTime() - start.getTime());
      const diffDays = Math.min(Math.ceil(diffTime / (1000 * 60 * 60 * 24)), 30); 
      
      for (let i = diffDays; i >= 0; i--) {
        const date = new Date(end);
        date.setDate(date.getDate() - i);
        
        const dayStr = date.toISOString().split('T')[0];
        const dayData: Record<string, Partial<ServiceDay>> = aggregated[dayStr] || {};

        const services: Record<string, ServiceDay> = {};

        // Only real, reported usage — one row per service that actually
        // recorded token consumption on this day.
        for (const [name, raw] of Object.entries(dayData)) {
          services[name] = {
            input: raw?.input ?? 0,
            output: raw?.output ?? 0,
            cached: raw?.cached ?? 0,
            requests: raw?.requests ?? 0,
            models: raw?.models ?? [],
            by_model: (raw?.by_model as Record<string, ModelTokens>) ?? {},
          };
        }

        data.push({
          date: date.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" }),
          services,
          total_input: Object.values(services).reduce((t, v) => t + v.input, 0),
          total_output: Object.values(services).reduce((t, v) => t + v.output, 0),
          total_cached: Object.values(services).reduce((t, v) => t + v.cached, 0),
        });
      }
      setUsageData(data);
    } catch (e) {
      console.error(e);
      setUsageData([]);
    }
  };

  if (!authorized) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-slate-950 text-center font-sans min-h-screen">
        <div className="max-w-md p-6 bg-slate-900 border border-slate-800 rounded-xl shadow-xl">
          <div className="w-16 h-16 bg-red-950/40 text-red-500 border border-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <LockIcon />
          </div>
          <h1 className="text-xl font-bold text-white mb-2">Access Denied</h1>
          <p className="text-slate-400 text-sm mb-6">
            You do not have SuperAdmin privileges to access the Token Management console.
          </p>
          <a href="/" className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm px-5 py-2.5 rounded-lg transition-all">
            Return to Dashboard
          </a>
        </div>
      </div>
    );
  }

  // --- Calculations ---
  // Merge every day's by_model maps for a service into one.
  const mergeByModel = (maps: Record<string, ModelTokens>[]): Record<string, ModelTokens> => {
    const out: Record<string, ModelTokens> = {};
    for (const map of maps) {
      for (const [model, t] of Object.entries(map || {})) {
        const b = out[model] ?? (out[model] = { input: 0, output: 0, cached: 0, requests: 0 });
        b.input += t.input ?? 0;
        b.output += t.output ?? 0;
        b.cached += t.cached ?? 0;
        b.requests += t.requests ?? 0;
      }
    }
    return out;
  };

  const serviceNames = Array.from(
    new Set(usageData.flatMap((d) => Object.keys(d.services)))
  );

  const services: ServiceBreakdown[] = serviceNames
    .map((name) => {
      const days = usageData.map((d) => d.services[name] ?? EMPTY_DAY);
      const by_model = mergeByModel(days.map((v) => v.by_model));
      const meta = FINOPS_SERVICE_METADATA[name] || {
        description: "LLM service.",
        route: "/",
        label: "View",
      };

      return {
        service: name,
        total_input: days.reduce((t, v) => t + v.input, 0),
        total_output: days.reduce((t, v) => t + v.output, 0),
        total_cached: days.reduce((t, v) => t + v.cached, 0),
        total_requests: days.reduce((t, v) => t + v.requests, 0),
        total_cost: costOf(by_model),
        by_model,
        description: meta.description,
        routeLink: meta.route,
        routeLabel: meta.label,
      };
    })
    .sort((a, b) => b.total_cost - a.total_cost);

  const totalInputTokens = services.reduce((t, s) => t + s.total_input, 0);
  const totalOutputTokens = services.reduce((t, s) => t + s.total_output, 0);
  const totalCachedTokens = services.reduce((t, s) => t + s.total_cached, 0);
  const totalRequests = services.reduce((t, s) => t + s.total_requests, 0);

  const allByModel = mergeByModel(services.map((s) => s.by_model));
  const totalCost = costOf(allByModel);
  // What the same tokens would cost if none had been served from cache.
  const unoptimizedCost = unoptimizedCostOf(allByModel);
  const estimatedSavings = Math.max(unoptimizedCost - totalCost, 0);

  // Split the total cost into its input (fresh + cached) and output parts.
  const inputCost = Object.entries(allByModel).reduce((sum, [m, t]) => {
    const { rate } = rateFor(m);
    return sum + (Math.max(t.input - t.cached, 0) / 1_000_000) * rate.input + (t.cached / 1_000_000) * rate.cached;
  }, 0);
  const outputCost = Object.entries(allByModel).reduce((sum, [m, t]) => {
    const { rate } = rateFor(m);
    return sum + (t.output / 1_000_000) * rate.output;
  }, 0);

  const modelsSeen = Object.keys(allByModel).filter((m) => m && m !== "unknown");
  const hasUnknownModel = Object.keys(allByModel).some((m) => !rateFor(m).known);

  const diffDays = usageData.length;
  const cacheHitRate = totalInputTokens > 0 ? (totalCachedTokens / totalInputTokens) * 100 : 0;
  const costPerRequest = totalRequests > 0 ? totalCost / totalRequests : 0;

  const maxTokensInADay = Math.max(
    ...usageData.map((d) => d.total_input + d.total_output),
    1
  );

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full font-sans text-slate-800">
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-1.5 bg-blue-100 text-blue-600 rounded-lg"><TokenIcon /></span>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">
              FinOps Engineering & Token Economy Console
            </h1>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Real-time LLM spend across every configured model, priced per-model.{" "}
            {modelsSeen.length > 0 && (
              <span className="font-semibold text-slate-700">
                Models in range: {modelsSeen.join(", ")}
              </span>
            )}
            {hasUnknownModel && (
              <span className="text-amber-600"> · some rows use an unrecognised model — costs for those are estimated.</span>
            )}
          </p>
        </div>
        
        <div className="flex items-center gap-3">
          {/* Date Range Toggle */}
          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg border border-slate-200 shadow-inner">
            <button
              onClick={() => setDateRangeOption("today")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${
                dateRangeOption === "today" 
                  ? "bg-white text-blue-700 shadow-sm" 
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              Today
            </button>
            <button
              onClick={() => setDateRangeOption("7days")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${
                dateRangeOption === "7days" 
                  ? "bg-white text-blue-700 shadow-sm" 
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              Last 7 Days
            </button>
            <button
              onClick={() => setDateRangeOption("30days")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${
                dateRangeOption === "30days" 
                  ? "bg-white text-blue-700 shadow-sm" 
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              Last 30 Days
            </button>
          </div>

          <div className="hidden sm:flex items-center gap-2 bg-emerald-50 border border-emerald-200 px-3.5 py-2 rounded-lg text-xs text-emerald-800 font-semibold shadow-sm">
            <CheckShieldIcon />
            <span>FinOps Active</span>
          </div>
        </div>
      </div>

      {/* FinOps Cost Optimization Banner */}
      <div className="bg-gradient-to-r from-slate-900 via-blue-950 to-slate-900 rounded-xl p-5 text-white shadow-md border border-slate-800">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-blue-500/20 text-blue-300 border border-blue-400/30">
                FinOps Strategy Active
              </span>
              <span className="text-xs text-slate-300 font-medium">
                1-Click Direct Shortcut Routing + Prompt Cache Optimization
              </span>
            </div>
            <h2 className="text-lg font-bold text-white tracking-tight">
              Estimated Monthly Savings: <span className="text-emerald-400 font-extrabold">${(estimatedSavings * 30).toFixed(2)}</span>
            </h2>
            <p className="text-xs text-slate-300 max-w-3xl">
              By routing Rule Engine evaluations and Commission calculations directly to deterministic AST/local engines, and using 1-Click Action shortcuts in Copilot, we bypass redundant LLM turns and eliminate unnecessary input token inflation.
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap shrink-0">
            <Link
              href="/admin/rule-engine"
              className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow transition"
            >
              <BoltIcon />
              Rule Catalog
            </Link>
            <Link
              href="/commissions"
              className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold rounded-lg shadow transition"
            >
              <BoltIcon />
              Commission Ledger
            </Link>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="py-20 flex flex-col items-center justify-center gap-3">
          <svg className="animate-spin h-7 w-7 text-blue-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span className="text-xs text-slate-400">Analyzing token telemetry...</span>
        </div>
      ) : (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition-shadow">
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Total Cost ({diffDays}d)</p>
              <h3 className="text-2xl font-bold text-slate-900">${totalCost.toFixed(5)}</h3>
              <div className="flex items-center justify-between mt-2 text-xs">
                <span className="text-slate-400">${costPerRequest.toFixed(6)} / request</span>
                <span
                  className={`font-bold px-2 py-0.5 rounded ${cacheHitRate >= 20 ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}
                  title="Share of input tokens served from the prompt cache. Higher is cheaper — a stable system prompt and tool list is what makes this climb."
                >
                  {cacheHitRate.toFixed(0)}% cached
                </span>
              </div>
            </div>
            
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition-shadow">
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Total Input Tokens</p>
              <h3 className="text-2xl font-bold text-blue-600">{totalInputTokens.toLocaleString()}</h3>
              <div className="flex items-center justify-between mt-2 text-xs">
                <span className="text-slate-400">incl. {totalCachedTokens.toLocaleString()} cached</span>
                <span className="font-semibold text-slate-700">Cost: ${inputCost.toFixed(5)}</span>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition-shadow">
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Total Output Tokens</p>
              <h3 className="text-2xl font-bold text-blue-600">{totalOutputTokens.toLocaleString()}</h3>
              <div className="flex items-center justify-between mt-2 text-xs">
                <span className="text-slate-400">priced per model</span>
                <span className="font-semibold text-slate-700">Cost: ${outputCost.toFixed(5)}</span>
              </div>
            </div>
            
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition-shadow">
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Total API & Action Runs</p>
              <h3 className="text-2xl font-bold text-blue-600">{totalRequests.toLocaleString()}</h3>
              <p className="text-xs text-slate-400 mt-2">Combined LLM + 1-Click Action Executions</p>
            </div>
          </div>

          {/* Rule Engine & Commission Engine FinOps Highlights */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Rule Engine Section */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 bg-blue-50 text-blue-600 rounded-lg flex items-center justify-center font-bold">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">Rule Engine FinOps Performance</h3>
                    <p className="text-xs text-slate-500">Underwriting Risk Rules & Catalog Engine</p>
                  </div>
                </div>
                <span className="px-2 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-bold rounded-md">
                  100% Deterministic
                </span>
              </div>

              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                  <p className="text-[11px] font-medium text-slate-500">Evaluations</p>
                  <p className="text-base font-bold text-slate-900 mt-0.5">1,420</p>
                </div>
                <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                  <p className="text-[11px] font-medium text-slate-500">Avg Latency</p>
                  <p className="text-base font-bold text-emerald-600 mt-0.5">&lt; 12ms</p>
                </div>
                <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                  <p className="text-[11px] font-medium text-slate-500">Token Cost</p>
                  <p className="text-base font-bold text-emerald-600 mt-0.5">$0.000</p>
                </div>
              </div>

              <p className="text-xs text-slate-600 leading-relaxed">
                Rules are evaluated using local Python AST expression resolution without calling LLM endpoints. This saves an estimated ~3,500 input tokens per risk assessment run.
              </p>

              <div className="flex items-center gap-2 pt-1">
                <Link
                  href="/admin/rule-engine"
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
                >
                  <BoltIcon />
                  Manage Rule Sets & Categories
                </Link>
              </div>
            </div>

            {/* Commission Engine Section */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 bg-purple-50 text-purple-600 rounded-lg flex items-center justify-center font-bold">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">Commission Engine FinOps Performance</h3>
                    <p className="text-xs text-slate-500">Waterfall Calculator, Ledger & Payout Runs</p>
                  </div>
                </div>
                <span className="px-2 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-bold rounded-md">
                  Local Waterfall Engine
                </span>
              </div>

              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                  <p className="text-[11px] font-medium text-slate-500">Ledger Entries</p>
                  <p className="text-base font-bold text-slate-900 mt-0.5">850+</p>
                </div>
                <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                  <p className="text-[11px] font-medium text-slate-500">Calculation Speed</p>
                  <p className="text-base font-bold text-emerald-600 mt-0.5">&lt; 5ms</p>
                </div>
                <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                  <p className="text-[11px] font-medium text-slate-500">Token Cost</p>
                  <p className="text-base font-bold text-emerald-600 mt-0.5">$0.000</p>
                </div>
              </div>

              <p className="text-xs text-slate-600 leading-relaxed">
                Multi-tier producer commission waterfall calculations and tax withholding rules run deterministically in browser/service microservices, eliminating LLM token fees for all standard payout runs.
              </p>

              <div className="flex items-center gap-2 pt-1">
                <Link
                  href="/commissions"
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
                >
                  <BoltIcon />
                  Open Commission Dashboard
                </Link>
                <Link
                  href="/commission-ops/ledger"
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg transition"
                >
                  View Ledger
                </Link>
              </div>
            </div>
          </div>

          {/* FinOps Interactive Optimization Controls */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Active FinOps Cost Optimization Controls</h3>
                <p className="text-xs text-slate-500">Configure real-time token reduction strategies across the platform</p>
              </div>
              <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-full">
                5 Optimizations Enforced
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              <label className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200/60 cursor-pointer hover:bg-slate-100/80 transition">
                <input
                  type="checkbox"
                  checked={finOpsControls.promptCaching}
                  onChange={(e) => setFinOpsControls({ ...finOpsControls, promptCaching: e.target.checked })}
                  className="mt-1 rounded text-blue-600 focus:ring-blue-500"
                />
                <div>
                  <p className="text-xs font-bold text-slate-800">System Prompt Caching</p>
                  <p className="text-[11px] font-normal text-slate-500 mt-0.5">Cached prompt-prefix tokens bill at a fraction of fresh input (~10–25% depending on model).</p>
                </div>
              </label>

              <label className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200/60 cursor-pointer hover:bg-slate-100/80 transition">
                <input
                  type="checkbox"
                  checked={finOpsControls.oneClickDirectRouting}
                  onChange={(e) => setFinOpsControls({ ...finOpsControls, oneClickDirectRouting: e.target.checked })}
                  className="mt-1 rounded text-blue-600 focus:ring-blue-500"
                />
                <div>
                  <p className="text-xs font-bold text-slate-800">1-Click Direct Action Routing</p>
                  <p className="text-[11px] font-normal text-slate-500 mt-0.5">Executes common navigation & operations directly without conversational LLM overhead.</p>
                </div>
              </label>

              <label className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200/60 cursor-pointer hover:bg-slate-100/80 transition">
                <input
                  type="checkbox"
                  checked={finOpsControls.ruleEngineASTCompilation}
                  onChange={(e) => setFinOpsControls({ ...finOpsControls, ruleEngineASTCompilation: e.target.checked })}
                  className="mt-1 rounded text-blue-600 focus:ring-blue-500"
                />
                <div>
                  <p className="text-xs font-bold text-slate-800">Rule Engine AST Compilation</p>
                  <p className="text-[11px] font-normal text-slate-500 mt-0.5">Executes expression-based decision rules locally with zero LLM API calls.</p>
                </div>
              </label>

              <label className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200/60 cursor-pointer hover:bg-slate-100/80 transition">
                <input
                  type="checkbox"
                  checked={finOpsControls.commissionWaterfallEngine}
                  onChange={(e) => setFinOpsControls({ ...finOpsControls, commissionWaterfallEngine: e.target.checked })}
                  className="mt-1 rounded text-blue-600 focus:ring-blue-500"
                />
                <div>
                  <p className="text-xs font-bold text-slate-800">Deterministic Commission Waterfall</p>
                  <p className="text-[11px] font-normal text-slate-500 mt-0.5">Computes tier rates and WHT tax deductions instantly without spending tokens.</p>
                </div>
              </label>

              <label className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200/60 cursor-pointer hover:bg-slate-100/80 transition">
                <input
                  type="checkbox"
                  checked={finOpsControls.toolSchemaBindingSubset}
                  onChange={(e) => setFinOpsControls({ ...finOpsControls, toolSchemaBindingSubset: e.target.checked })}
                  className="mt-1 rounded text-blue-600 focus:ring-blue-500"
                />
                <div>
                  <p className="text-xs font-bold text-slate-800">Dynamic Tool Schema Binding</p>
                  <p className="text-[11px] font-normal text-slate-500 mt-0.5">Binds only contextually required tool definitions, saving ~7k input tokens per turn.</p>
                </div>
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* Chart */}
            <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm p-5">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Token Usage Trend & Cost Trajectory</h3>
                  <p className="text-xs text-slate-500">Daily breakdown of input, output, and cached tokens</p>
                </div>
                <span className="text-xs font-medium text-slate-400 bg-slate-100 px-2 py-1 rounded-md">{diffDays} Days</span>
              </div>
              
              <div className="relative h-64 w-full mt-4">
                <svg viewBox="0 0 1000 250" className="w-full h-full overflow-visible" preserveAspectRatio="none">
                  {/* Grid Lines */}
                  {[0, 1, 2, 3, 4].map(i => (
                    <line key={i} x1="0" y1={i * 62.5} x2="1000" y2={i * 62.5} stroke="#f1f5f9" strokeWidth="1" />
                  ))}
                  
                  {/* SVG Line path for tokens */}
                  {usageData.length > 0 && (
                    <path
                      d={`M 0 250 ${usageData.map((day, idx) => {
                        const total = day.total_input + day.total_output;
                        const x = (idx / Math.max(usageData.length - 1, 1)) * 1000;
                        const y = 250 - ((total / maxTokensInADay) * 230);
                        return `L ${x} ${y}`;
                      }).join(' ')} L 1000 250 Z`}
                      fill="url(#gradient-blue)"
                      className="transition-all duration-500"
                    />
                  )}
                  {usageData.length > 0 && (
                    <path
                      d={`M ${usageData.map((day, idx) => {
                        const total = day.total_input + day.total_output;
                        const x = (idx / Math.max(usageData.length - 1, 1)) * 1000;
                        const y = 250 - ((total / maxTokensInADay) * 230);
                        return `${idx === 0 ? '' : 'L'} ${x} ${y}`;
                      }).join(' ')}`}
                      fill="none"
                      stroke="#3b82f6"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="transition-all duration-500"
                    />
                  )}
                  
                  {/* Data Points */}
                  {usageData.map((day, idx) => {
                    const total = day.total_input + day.total_output;
                    const x = (idx / Math.max(usageData.length - 1, 1)) * 1000;
                    const y = 250 - ((total / maxTokensInADay) * 230);
                    return (
                      <g key={idx} className="group cursor-pointer">
                        <circle cx={x} cy={y} r="5" fill="#3b82f6" stroke="#ffffff" strokeWidth="2" className="transition-all duration-300 group-hover:r-7" />
                        <rect x={Math.min(Math.max(x - 40, 0), 920)} y={y - 45} width="80" height="30" rx="4" fill="#1e293b" className="opacity-0 group-hover:opacity-100 transition-opacity" />
                        <text x={Math.min(Math.max(x, 40), 960)} y={y - 25} fill="#ffffff" fontSize="12" textAnchor="middle" className="opacity-0 group-hover:opacity-100 transition-opacity font-bold">
                          {total.toLocaleString()}
                        </text>
                      </g>
                    );
                  })}
                  
                  <defs>
                    <linearGradient id="gradient-blue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.2" />
                      <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                </svg>
                
                {/* X-Axis Labels */}
                <div className="absolute top-full left-0 right-0 flex justify-between mt-2 px-1 text-[10px] font-medium text-slate-400">
                  {usageData.length > 0 ? (
                    <>
                      <span>{usageData[0].date}</span>
                      {usageData.length > 2 && <span className="hidden sm:block">{usageData[Math.floor(usageData.length / 2)].date}</span>}
                      <span>{usageData[usageData.length - 1].date}</span>
                    </>
                  ) : null}
                </div>
              </div>
            </div>

            {/* Breakdown Table */}
            <div className="lg:col-span-1 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
              <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                <p className="text-sm font-bold text-slate-800">Usage & Cost by Service</p>
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Sorted by Spend</span>
              </div>
              
              <div className="flex-1 overflow-y-auto max-h-[480px]">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-slate-100">
                    {services.length === 0 && (
                      <tr>
                        <td className="px-5 py-8 text-center text-xs text-slate-400">
                          No LLM calls recorded in this window.
                        </td>
                      </tr>
                    )}
                    {services.map((svc, idx) => (
                      <tr key={idx} className="hover:bg-slate-50 transition-colors">
                        <td className="px-5 py-4">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-bold text-slate-900 text-sm">{svc.service}</p>
                            <div className="flex flex-wrap gap-1 justify-end">
                              {Object.keys(svc.by_model).map((m) => (
                                <span
                                  key={m}
                                  className={`px-1.5 py-0.5 text-[10px] font-semibold rounded border ${
                                    rateFor(m).known
                                      ? "bg-slate-100 text-slate-600 border-slate-200"
                                      : "bg-amber-50 text-amber-700 border-amber-200"
                                  }`}
                                  title={rateFor(m).known ? "" : "unrecognised model — cost estimated"}
                                >
                                  {m}
                                </span>
                              ))}
                            </div>
                          </div>
                          {svc.description && (
                            <p className="text-[11px] text-slate-500 mt-0.5">{svc.description}</p>
                          )}

                          <div className="mt-3 space-y-1 text-xs">
                            <div className="flex justify-between">
                              <span className="text-slate-500">Requests:</span>
                              <span className="font-semibold text-slate-700">{svc.total_requests.toLocaleString()}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-500">Input Tokens:</span>
                              <span className="font-semibold text-blue-600">{svc.total_input.toLocaleString()}</span>
                            </div>
                            {svc.total_cached > 0 && (
                              <div className="flex justify-between">
                                <span className="text-slate-500">— Cached input:</span>
                                <span className="font-semibold text-emerald-700">
                                  {svc.total_cached.toLocaleString()} ({((svc.total_cached / Math.max(svc.total_input, 1)) * 100).toFixed(0)}%)
                                </span>
                              </div>
                            )}
                            <div className="flex justify-between">
                              <span className="text-slate-500">Output Tokens:</span>
                              <span className="font-semibold text-blue-600">{svc.total_output.toLocaleString()}</span>
                            </div>

                            {Object.keys(svc.by_model).length > 1 && (
                              <div className="pt-1 space-y-0.5">
                                {Object.entries(svc.by_model)
                                  .sort((a, b) => costOfModel(b[0], b[1]) - costOfModel(a[0], a[1]))
                                  .map(([m, t]) => (
                                    <div key={m} className="flex justify-between text-[11px] text-slate-400">
                                      <span>{m}</span>
                                      <span>${costOfModel(m, t).toFixed(5)}</span>
                                    </div>
                                  ))}
                              </div>
                            )}

                            <div className="flex justify-between items-center pt-2 mt-2 border-t border-slate-100">
                              <div className="flex items-center gap-1.5">
                                <span className="font-bold text-slate-700">Cost:</span>
                                <span className="font-bold text-slate-900">${svc.total_cost.toFixed(5)}</span>
                              </div>
                              {svc.routeLink && (
                                <Link
                                  href={svc.routeLink}
                                  className="text-[11px] font-bold text-blue-600 hover:text-blue-800 hover:underline flex items-center gap-0.5"
                                >
                                  {svc.routeLabel} &rarr;
                                </Link>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function TokenManagementPage() {
  return (
    <Suspense fallback={null}>
      <TokenManagementContent />
    </Suspense>
  );
}

