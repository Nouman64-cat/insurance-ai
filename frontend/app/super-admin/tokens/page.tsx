"use client";

import { useState, useEffect, Suspense } from "react";
import api from "@/app/services/api";

// --- Configuration & Constants ---
const LLM_MODEL = "gemini-2.5-flash";
const INPUT_COST_PER_MILLION = 0.075;
const OUTPUT_COST_PER_MILLION = 0.300;

// --- Mock Data Interfaces ---
interface DailyUsage {
  date: string;
  ocr_input: number;
  ocr_output: number;
  ocr_requests: number;
  summarizer_input: number;
  summarizer_output: number;
  summarizer_requests: number;
}

interface ServiceBreakdown {
  service: string;
  total_input: number;
  total_output: number;
  total_requests: number;
  total_cost: number;
}

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

function CalendarIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function TokenManagementContent() {
  const [authorized, setAuthorized] = useState(true);
  const [loading, setLoading] = useState(true);
  const [usageData, setUsageData] = useState<DailyUsage[]>([]);
  
  type DateRangeOption = "today" | "7days" | "30days";
  const [dateRangeOption, setDateRangeOption] = useState<DateRangeOption>("7days");
  
  // Date Range State
  const defaultEndDate = new Date();
  const defaultStartDate = new Date();
  defaultStartDate.setDate(defaultEndDate.getDate() - 6);
  
  const [startDate, setStartDate] = useState(defaultStartDate.toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState(defaultEndDate.toISOString().split('T')[0]);

  // Authorization Check
  useEffect(() => {
    const role = localStorage.getItem("user_role");
    if (role !== "SuperAdmin") {
      setAuthorized(false);
      setLoading(false);
      return;
    }
    
    // Fetch real token data from backend
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
        const dayData = aggregated[dayStr] || {};
        
        const ocr = dayData["OCR Engine"] || { input: 0, output: 0, requests: 0 };
        const sum = dayData["Text Summarizer"] || { input: 0, output: 0, requests: 0 };
        
        data.push({
          date: date.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" }),
          ocr_input: ocr.input,
          ocr_output: ocr.output,
          ocr_requests: ocr.requests,
          summarizer_input: sum.input,
          summarizer_output: sum.output,
          summarizer_requests: sum.requests,
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
  const totalOcrInput = usageData.reduce((sum, day) => sum + day.ocr_input, 0);
  const totalOcrOutput = usageData.reduce((sum, day) => sum + day.ocr_output, 0);
  const totalOcrRequests = usageData.reduce((sum, day) => sum + day.ocr_requests, 0);
  
  const totalSumInput = usageData.reduce((sum, day) => sum + day.summarizer_input, 0);
  const totalSumOutput = usageData.reduce((sum, day) => sum + day.summarizer_output, 0);
  const totalSumRequests = usageData.reduce((sum, day) => sum + day.summarizer_requests, 0);

  const totalInputTokens = totalOcrInput + totalSumInput;
  const totalOutputTokens = totalOcrOutput + totalSumOutput;
  const totalRequests = totalOcrRequests + totalSumRequests;

  const calculateCost = (input: number, output: number) => {
    return ((input / 1_000_000) * INPUT_COST_PER_MILLION) + ((output / 1_000_000) * OUTPUT_COST_PER_MILLION);
  };

  const totalCost = calculateCost(totalInputTokens, totalOutputTokens);
  const diffDays = usageData.length;
  
  const services: ServiceBreakdown[] = [
    {
      service: "OCR Engine",
      total_input: totalOcrInput,
      total_output: totalOcrOutput,
      total_requests: totalOcrRequests,
      total_cost: calculateCost(totalOcrInput, totalOcrOutput)
    },
    {
      service: "Text Summarizer",
      total_input: totalSumInput,
      total_output: totalSumOutput,
      total_requests: totalSumRequests,
      total_cost: calculateCost(totalSumInput, totalSumOutput)
    }
  ];

  // Chart Logic
  const maxTokensInADay = Math.max(...usageData.map(d => d.ocr_input + d.ocr_output + d.summarizer_input + d.summarizer_output), 1);

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full font-sans">
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <span className="text-blue-600"><TokenIcon /></span>
            Token Management
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Monitor API token consumption and costs across {LLM_MODEL}.
          </p>
        </div>
        
        <div className="flex items-center gap-3">
          {/* Date Range Toggle */}
          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg border border-slate-200 shadow-inner">
            <button
              onClick={() => setDateRangeOption("today")}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all ${
                dateRangeOption === "today" 
                  ? "bg-white text-blue-700 shadow-sm" 
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              Today
            </button>
            <button
              onClick={() => setDateRangeOption("7days")}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all ${
                dateRangeOption === "7days" 
                  ? "bg-white text-blue-700 shadow-sm" 
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              Last 7 Days
            </button>
            <button
              onClick={() => setDateRangeOption("30days")}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all ${
                dateRangeOption === "30days" 
                  ? "bg-white text-blue-700 shadow-sm" 
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              Last 30 Days
            </button>
          </div>

          <div className="hidden sm:block bg-blue-50 border border-blue-100 px-4 py-2.5 rounded-lg text-sm text-blue-700 font-medium whitespace-nowrap">
            LLM: <span className="font-bold">{LLM_MODEL}</span>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="py-20 flex flex-col items-center justify-center gap-3">
          <svg className="animate-spin h-7 w-7 text-blue-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span className="text-xs text-slate-400">Loading token usage...</span>
        </div>
      ) : (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition-shadow">
              <p className="text-sm font-semibold text-slate-500 mb-1">Total Cost ({diffDays}d)</p>
              <h3 className="text-2xl font-bold text-slate-900">${totalCost.toFixed(5)}</h3>
              <p className="text-xs text-slate-400 mt-2">Based on Gemini Flash Pricing</p>
            </div>
            
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition-shadow">
              <p className="text-sm font-semibold text-slate-500 mb-1">Total Input Tokens</p>
              <h3 className="text-2xl font-bold text-blue-600">{totalInputTokens.toLocaleString()}</h3>
              <div className="flex items-center justify-between mt-2">
                <p className="text-xs text-slate-400">${INPUT_COST_PER_MILLION} / 1M</p>
                <p className="text-xs font-semibold text-slate-600">Cost: ${((totalInputTokens / 1_000_000) * INPUT_COST_PER_MILLION).toFixed(5)}</p>
              </div>
            </div>
            
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition-shadow">
              <p className="text-sm font-semibold text-slate-500 mb-1">Total Output Tokens</p>
              <h3 className="text-2xl font-bold text-blue-600">{totalOutputTokens.toLocaleString()}</h3>
              <div className="flex items-center justify-between mt-2">
                <p className="text-xs text-slate-400">${OUTPUT_COST_PER_MILLION} / 1M</p>
                <p className="text-xs font-semibold text-slate-600">Cost: ${((totalOutputTokens / 1_000_000) * OUTPUT_COST_PER_MILLION).toFixed(5)}</p>
              </div>
            </div>
            
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition-shadow">
              <p className="text-sm font-semibold text-slate-500 mb-1">Total API Requests</p>
              <h3 className="text-2xl font-bold text-blue-600">{totalRequests.toLocaleString()}</h3>
              <p className="text-xs text-slate-400 mt-2">Successful generations</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* Chart */}
            <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm p-5">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-sm font-semibold text-slate-700">Token Usage Trend</h3>
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
                        const total = day.ocr_input + day.ocr_output + day.summarizer_input + day.summarizer_output;
                        const x = (idx / Math.max(usageData.length - 1, 1)) * 1000;
                        const y = 250 - ((total / maxTokensInADay) * 230); // 20px padding at top
                        return `L ${x} ${y}`;
                      }).join(' ')} L 1000 250 Z`}
                      fill="url(#gradient-blue)"
                      className="transition-all duration-500"
                    />
                  )}
                  {usageData.length > 0 && (
                    <path
                      d={`M ${usageData.map((day, idx) => {
                        const total = day.ocr_input + day.ocr_output + day.summarizer_input + day.summarizer_output;
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
                    const total = day.ocr_input + day.ocr_output + day.summarizer_input + day.summarizer_output;
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
              <div className="px-5 py-4 border-b border-slate-100 bg-slate-50">
                <p className="text-sm font-semibold text-slate-700">Usage by Service</p>
              </div>
              
              <div className="flex-1 overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-slate-100">
                    {services.map((svc, idx) => (
                      <tr key={idx} className="hover:bg-slate-50 transition-colors">
                        <td className="px-5 py-4">
                          <p className="font-bold text-slate-800">{svc.service}</p>
                          <div className="mt-2 space-y-1 text-xs">
                            <div className="flex justify-between">
                              <span className="text-slate-500">Requests:</span>
                              <span className="font-medium text-slate-700">{svc.total_requests.toLocaleString()}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-500">Input Tokens:</span>
                              <span className="font-medium text-blue-600">{svc.total_input.toLocaleString()}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-500">Output Tokens:</span>
                              <span className="font-medium text-blue-600">{svc.total_output.toLocaleString()}</span>
                            </div>
                            <div className="flex justify-between pt-2 mt-2 border-t border-slate-100">
                              <span className="font-bold text-slate-700">Cost:</span>
                              <span className="font-bold text-slate-900">${svc.total_cost.toFixed(5)}</span>
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
