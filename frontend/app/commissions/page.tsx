"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import {
  CommissionLedgerEntry,
  CommissionSummaryStats,
  CommissionRule,
  SECP_DEFAULT_RULES,
  listCommissionLedger,
  getCommissionStats,
  resetLedgerCache,
  disburseCommission,
  triggerClawback,
  calculateCommissionForPolicy,
  PremiumType,
  PolicySegment,
} from "../services/commissions";

export default function CommissionsPage() {
  const [activeTab, setActiveTab] = useState<"tracing" | "finances" | "general" | "calculator">("tracing");
  const [ledger, setLedger] = useState<CommissionLedgerEntry[]>([]);
  const [stats, setStats] = useState<CommissionSummaryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [notification, setNotification] = useState<{ msg: string; type: "success" | "error" } | null>(null);

  // Filter states
  const [selectedSegment, setSelectedSegment] = useState<string>("all");
  const [selectedType, setSelectedType] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState<string>("");

  // Interactive Calculator State
  const [calcPremium, setCalcPremium] = useState<number>(300000);
  const [calcSegment, setCalcSegment] = useState<PolicySegment>("individual");
  const [calcType, setCalcType] = useState<PremiumType>("FIRST_YEAR");
  const [calcYear, setCalcYear] = useState<number>(1);
  const [calcCustomer, setCalcCustomer] = useState<string>("Muhammad Usman");
  const [calcAgent, setCalcAgent] = useState<string>("Tariq Mansoor");

  // Clawback Modal State
  const [activeClawbackEntry, setActiveClawbackEntry] = useState<CommissionLedgerEntry | null>(null);
  const [clawbackReasonInput, setClawbackReasonInput] = useState<string>(
    "Policy Cancelled under SECP 14-Day Free-Look Period (Rule 62)"
  );

  const loadData = async () => {
    setLoading(true);
    try {
      resetLedgerCache();
      const [lData, sData] = await Promise.all([listCommissionLedger(), getCommissionStats()]);
      setLedger(lData);
      setStats(sData);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const notify = (msg: string, isSuccess = true) => {
    setNotification({ msg, type: isSuccess ? "success" : "error" });
    setTimeout(() => setNotification(null), 4000);
  };

  const fmtPKR = (val: number) => {
    return new Intl.NumberFormat("en-PK", {
      style: "currency",
      currency: "PKR",
      maximumFractionDigits: 0,
    }).format(val);
  };

  const handleDisburse = async (id: string) => {
    try {
      await disburseCommission(id);
      notify("Commission successfully disbursed to agent bank account!");
      loadData();
    } catch (err) {
      notify("Failed to disburse commission.", false);
    }
  };

  const handleExecuteClawback = async () => {
    if (!activeClawbackEntry) return;
    try {
      await triggerClawback(activeClawbackEntry.id, clawbackReasonInput);
      notify(`Clawback / Reversal executed for ${activeClawbackEntry.policyNumber}!`);
      setActiveClawbackEntry(null);
      loadData();
    } catch (err) {
      notify("Failed to execute clawback.", false);
    }
  };

  const handleCalculateAndAccrue = async () => {
    try {
      await calculateCommissionForPolicy({
        leadId: `LEAD-${Math.floor(8000 + Math.random() * 1000)}`,
        agentId: "AGT-001",
        agentName: calcAgent,
        policyId: `PL-${Math.floor(10000 + Math.random() * 90000)}`,
        policyNumber: `PL-ADAM-${Math.floor(10000 + Math.random() * 90000)}`,
        customerName: calcCustomer,
        segment: calcSegment,
        productName: "Adamjee Life Custom Protection Plan",
        premiumType: calcType,
        policyYear: calcYear,
        collectedPremium: calcPremium,
        isRealized: true,
        isIssued: true,
      });
      notify("New Commission Entry calculated and accrued to Ledger!");
      setActiveTab("finances");
      loadData();
    } catch (err) {
      notify("Failed to calculate commission.", false);
    }
  };

  // Calculated Preview
  const currentRule = SECP_DEFAULT_RULES.find(
    (r) => r.segment === calcSegment && r.premiumType === calcType && r.policyYear === Math.min(calcYear, 3)
  ) || { ratePct: calcType === "FIRST_YEAR" ? 35.0 : calcType === "SINGLE_PREMIUM" ? 2.5 : 5.0 };

  const calcGross = Math.round((calcPremium * currentRule.ratePct) / 100);
  const calcWht = Math.round(calcGross * 0.10);
  const calcNet = calcGross - calcWht;

  const filteredLedger = ledger.filter((l) => {
    if (selectedSegment !== "all" && l.segment !== selectedSegment) return false;
    if (selectedType !== "all" && l.premiumType !== selectedType) return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      return (
        l.agentName.toLowerCase().includes(q) ||
        l.customerName.toLowerCase().includes(q) ||
        l.policyNumber.toLowerCase().includes(q) ||
        l.leadId.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 space-y-6">
      {/* Toast Notification */}
      {notification && (
        <div
          className={`fixed top-5 right-5 z-50 px-4 py-3 rounded-xl shadow-xl border text-xs font-bold flex items-center gap-2 animate-in slide-in-from-top-2 ${notification.type === "success"
              ? "bg-blue-900 text-blue-100 border-blue-700"
              : "bg-slate-900 text-slate-100 border-slate-700"
            }`}
        >
          <span>{notification.type === "success" ? "✓" : "✕"}</span>
          <span>{notification.msg}</span>
        </div>
      )}

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Commissions</h1>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/underwriting"
            className="px-3.5 py-2 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-xl text-xs font-bold transition-all"
          >
            ← Back to Underwriting
          </Link>
          <button
            onClick={() => setActiveTab("calculator")}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold shadow-sm transition-all flex items-center gap-1.5"
          >
            <span>+</span>
            <span>Calculate Commission</span>
          </button>
        </div>
      </div>

      {/* Metric Cards Grid */}
      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs space-y-1">
            <div className="text-slate-500 text-[11px] font-semibold">
              <span>Total Gross</span>
            </div>
            <p className="text-xl font-extrabold text-slate-900 font-mono">{fmtPKR(stats.totalGrossCommission)}</p>
            <p className="text-[10px] text-slate-400">Total gross commission</p>
          </div>

          <div className="bg-white p-4 rounded-2xl border border-blue-200 shadow-xs space-y-1">
            <div className="text-blue-900 text-[11px] font-semibold">
              <span>Total Accrued</span>
            </div>
            <p className="text-xl font-extrabold text-blue-700 font-mono">{fmtPKR(stats.totalAccruedLiability)}</p>
            <p className="text-[10px] text-slate-400">Total accrued commission</p>
          </div>

          <div className="bg-white p-4 rounded-2xl border border-blue-200 shadow-xs space-y-1">
            <div className="text-blue-800 text-[11px] font-semibold">
              <span>Total Paid</span>
            </div>
            <p className="text-xl font-extrabold text-blue-700 font-mono">{fmtPKR(stats.totalDisbursed)}</p>
            <p className="text-[10px] text-slate-400">Total paid after tax</p>
          </div>

          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs space-y-1">
            <div className="text-slate-800 text-[11px] font-semibold">
              <span>Clawbacks</span>
            </div>
            <p className="text-xl font-extrabold text-slate-700 font-mono">{fmtPKR(stats.totalClawbacks)}</p>
            <p className="text-[10px] text-slate-400">Reversed commissions</p>
          </div>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="border-b border-slate-200 flex gap-2">
        <button
          onClick={() => setActiveTab("tracing")}
          className={`pb-3 px-4 font-bold text-xs border-b-2 transition-all ${activeTab === "tracing"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
        >
          Traceability
        </button>
        <button
          onClick={() => setActiveTab("finances")}
          className={`pb-3 px-4 font-bold text-xs border-b-2 transition-all ${activeTab === "finances"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
        >
          Ledger: Finances
        </button>
        <button
          onClick={() => setActiveTab("general")}
          className={`pb-3 px-4 font-bold text-xs border-b-2 transition-all ${activeTab === "general"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
        >
          Ledger: General Info
        </button>
        <button
          onClick={() => setActiveTab("calculator")}
          className={`pb-3 px-4 font-bold text-xs border-b-2 transition-all ${activeTab === "calculator"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
        >
          Calculator
        </button>
      </div>

      {/* ── TAB 2 & 3: COMMISSION LEDGER ────────────────────────────── */}
      {(activeTab === "finances" || activeTab === "general") && (
        <div className="space-y-4">
          {/* Search & Filter Control Bar */}
          <div className="bg-white p-4 rounded-xl border border-slate-200 flex flex-wrap gap-3 items-center justify-between">
            <div className="flex items-center gap-3 flex-1 min-w-[280px]">
              <input
                type="text"
                placeholder="Search Agent, Customer, Policy #, or Lead ID..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-1.5 text-xs text-slate-800 focus:outline-hidden focus:border-blue-500"
              />
            </div>
            <div className="flex gap-2 text-xs">
              <select
                value={selectedSegment}
                onChange={(e) => setSelectedSegment(e.target.value)}
                className="bg-slate-50 border border-slate-300 rounded-lg px-2.5 py-1.5 font-medium text-slate-700"
              >
                <option value="all">All Segments (Individual/Group/Family)</option>
                <option value="individual">Individual Life</option>
                <option value="group">Group Corporate</option>
                <option value="family">Family Takaful</option>
              </select>
              <select
                value={selectedType}
                onChange={(e) => setSelectedType(e.target.value)}
                className="bg-slate-50 border border-slate-300 rounded-lg px-2.5 py-1.5 font-medium text-slate-700"
              >
                <option value="all">All Premium Types (FYP/RYP/Single)</option>
                <option value="FIRST_YEAR">First-Year Premium (FYP)</option>
                <option value="RENEWAL">Renewal Premium (RYP)</option>
                <option value="SINGLE_PREMIUM">Single Premium (SP)</option>
              </select>
            </div>
          </div>

          {/* Ledger Table */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-100 text-slate-700 font-bold uppercase tracking-wider text-[10px] border-b border-slate-200">
                  <tr>
                    <th className="p-3 text-left">Ref ID &amp; Lead ID</th>
                    {activeTab === "general" && <th className="p-3 text-left">Business Partner</th>}
                    {activeTab === "general" && <th className="p-3 text-left">Customer</th>}
                    <th className="p-3 text-left">Premium Type &amp; Rate</th>
                    <th className="p-3 text-right">Collected Premium</th>
                    {activeTab === "finances" && <th className="p-3 text-right">Gross Commission</th>}
                    {activeTab === "finances" && <th className="p-3 text-right">WHT (10%)</th>}
                    {activeTab === "finances" && <th className="p-3 text-right">Net Commission</th>}
                    {activeTab === "finances" && <th className="p-3 text-center">Status</th>}
                    {activeTab === "finances" && <th className="p-3 text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-800">
                  {filteredLedger.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="p-3 text-left">
                        <p className="font-mono font-bold text-blue-900">{item.id}</p>
                        <span className="text-[10px] text-slate-400 font-mono">Trace: {item.leadId}</span>
                      </td>
                      {activeTab === "general" && (
                        <td className="p-3 text-left">
                          <p className="font-bold text-slate-900">{item.agentName}</p>
                          <p className="text-[10px] font-mono text-slate-400">{item.agentCode}</p>
                        </td>
                      )}
                      {activeTab === "general" && (
                        <td className="p-3 text-left">
                          <p className="font-semibold text-slate-800">{item.customerName}</p>
                          <p className="text-[10px] font-mono text-blue-700">{item.policyNumber}</p>
                          <span className="text-[9px] uppercase px-1.5 py-0.2 rounded bg-slate-100 font-bold text-slate-500">
                            {item.segment}
                          </span>
                        </td>
                      )}
                      <td className="p-3 text-left">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-extrabold border ${item.premiumType === "FIRST_YEAR"
                              ? "bg-blue-50 text-blue-700 border-blue-200"
                              : item.premiumType === "RENEWAL"
                                ? "bg-blue-50 text-blue-700 border-blue-200"
                                : "bg-slate-50 text-slate-800 border-slate-200"
                            }`}
                        >
                          {item.premiumType.replace("_", " ")} (Yr {item.policyYear})
                        </span>
                        <p className="text-[10px] font-bold text-slate-600 mt-1">Rate: {item.ratePct}%</p>
                      </td>
                      <td className="p-3 text-right font-mono font-bold text-slate-800">
                        {fmtPKR(item.collectedPremium)}
                      </td>
                      {activeTab === "finances" && (
                        <>
                          <td className="p-3 text-right font-mono font-bold text-slate-900 text-xs">
                            {fmtPKR(item.grossCommission)}
                          </td>
                          <td className="p-3 text-right font-mono text-slate-500 text-xs">
                            - {fmtPKR(item.whtTax)}
                          </td>
                          <td className="p-3 text-right font-mono font-extrabold text-blue-700 text-sm">
                            {fmtPKR(item.netCommission)}
                          </td>
                          <td className="p-3 text-center">
                            <span
                              title={
                                item.gatingReason
                                  ? item.gatingReason
                                      .replace(/Cash Realization Confirmation|Cash Realization/gi, "Premium Collection")
                                      .replace(/Cash Realized/gi, "Premium Collected")
                                  : ""
                              }
                              className={`px-2.5 py-1 rounded-full text-[10px] font-extrabold border inline-block cursor-help ${
                                item.status === "DISBURSED"
                                  ? "bg-blue-100 text-blue-800 border-blue-300"
                                  : item.status === "PAYABLE"
                                    ? "bg-blue-100 text-blue-800 border-blue-300"
                                    : item.status === "CLAWED_BACK"
                                      ? "bg-slate-100 text-slate-800 border-slate-300"
                                      : "bg-slate-100 text-slate-700 border-slate-300"
                              }`}
                            >
                              {item.status}
                            </span>
                          </td>
                          <td className="p-3 text-right space-x-1">
                            {item.status === "PAYABLE" && (
                              <button
                                onClick={() => handleDisburse(item.id)}
                                className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white font-bold text-[10px] rounded-lg shadow-2xs transition-colors"
                              >
                                Disburse →
                              </button>
                            )}
                            {item.status !== "CLAWED_BACK" && (
                              <button
                                onClick={() => setActiveClawbackEntry(item)}
                                className="px-2 py-1 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 font-bold text-[10px] rounded-lg transition-colors"
                              >
                                Rule 62 Clawback
                              </button>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── TAB 3: INTERACTIVE RATING & ACCRUAL MODELER ───────────────────────── */}
      {activeTab === "calculator" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-white p-6 rounded-2xl border border-slate-200 space-y-4 shadow-xs">
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider border-b pb-2">
              SECP Statutory Commission Calculation Inputs
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Customer / Proposer Name</label>
                <input
                  type="text"
                  value={calcCustomer}
                  onChange={(e) => setCalcCustomer(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded-xl text-xs"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Assigned Agent</label>
                <input
                  type="text"
                  value={calcAgent}
                  onChange={(e) => setCalcAgent(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded-xl text-xs"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Recognized Premium (PKR)</label>
                <input
                  type="number"
                  value={calcPremium}
                  onChange={(e) => setCalcPremium(Number(e.target.value))}
                  className="w-full p-2 border border-slate-300 rounded-xl text-xs font-mono font-bold text-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Policy Segment</label>
                <select
                  value={calcSegment}
                  onChange={(e) => setCalcSegment(e.target.value as PolicySegment)}
                  className="w-full p-2 border border-slate-300 rounded-xl text-xs"
                >
                  <option value="individual">Individual Life Insurance</option>
                  <option value="group">Group Corporate Policy</option>
                  <option value="family">Family Takaful</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Premium Type (Form LG)</label>
                <select
                  value={calcType}
                  onChange={(e) => setCalcType(e.target.value as PremiumType)}
                  className="w-full p-2 border border-slate-300 rounded-xl text-xs"
                >
                  <option value="FIRST_YEAR">First-Year Premium (FYP)</option>
                  <option value="RENEWAL">Renewal Premium (RYP)</option>
                  <option value="SINGLE_PREMIUM">Single Premium (SP)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Policy Year</label>
                <select
                  value={calcYear}
                  onChange={(e) => setCalcYear(Number(e.target.value))}
                  className="w-full p-2 border border-slate-300 rounded-xl text-xs"
                >
                  <option value={1}>Year 1 (Acquisition)</option>
                  <option value={2}>Year 2 (Persistency)</option>
                  <option value={3}>Year 3+ (Renewal Trail)</option>
                </select>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-100 flex justify-end">
              <button
                onClick={handleCalculateAndAccrue}
                className="px-5 py-2.5 bg-blue-700 hover:bg-blue-800 text-white font-bold text-xs rounded-xl shadow-md transition-all"
              >
                Accrue Commission to Ledger →
              </button>
            </div>
          </div>

          {/* Real-time Calculation Breakdown Preview */}
          <div className="bg-slate-900 text-white p-6 rounded-2xl shadow-xl space-y-4 border border-slate-800 flex flex-col justify-between">
            <div className="space-y-3">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                <h3 className="font-bold text-xs text-blue-200 uppercase tracking-wider">
                  Commission Computation Result
                </h3>
                <span className="px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 font-mono text-[10px] font-bold">
                  Rule 24 Matched
                </span>
              </div>

              <div className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-400">Applicable Rate:</span>
                  <span className="font-mono font-bold text-blue-300">{currentRule.ratePct}%</span>
                </div>

                <div className="flex justify-between">
                  <span className="text-slate-400">Gross Commission:</span>
                  <span className="font-mono font-bold text-white">{fmtPKR(calcGross)}</span>
                </div>

                <div className="flex justify-between text-slate-300">
                  <span>SECP WHT Deduction (10%):</span>
                  <span className="font-mono font-bold">- {fmtPKR(calcWht)}</span>
                </div>

                <div className="pt-3 border-t border-slate-800 flex justify-between items-center">
                  <span className="font-bold text-slate-300">Net Payable Commission:</span>
                  <span className="font-mono font-black text-blue-400 text-lg">{fmtPKR(calcNet)}</span>
                </div>
              </div>
            </div>

            <div className="bg-slate-800/80 p-3 rounded-xl border border-slate-700/60 text-[10px] text-slate-400 space-y-1">
              <p className="font-bold text-slate-300">Note:</p>
              <p>Commission is paid after payment is received.</p>
            </div>
          </div>
        </div>
      )}

      {/* ── TAB 1: LEAD-TO-AGENT TRACEABILITY LIFECYCLE ───────────────────────── */}
      {activeTab === "tracing" && (
        <div className="bg-white p-6 rounded-2xl border border-slate-200 space-y-6 shadow-xs">
          <div>
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
              Traceability
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Trace policy flow from lead to commission.
            </p>
          </div>

          <div className="space-y-4">
            {ledger.map((item) => (
              <div key={item.id} className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
                <div className="flex flex-wrap justify-between items-center gap-2 border-b border-slate-200 pb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-xs text-blue-900">{item.leadId}</span>
                    <span className="text-slate-500 text-sm font-black">➔</span>
                    <span className="font-bold text-xs text-slate-800">{item.agentName} ({item.agentCode})</span>
                    <span className="text-slate-500 text-sm font-black">➔</span>
                    <span className="font-mono font-bold text-xs text-blue-700">{item.policyNumber}</span>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-800 font-mono font-bold text-xs">
                    Payout: {fmtPKR(item.netCommission)}
                  </span>
                </div>

                {/* 6-Step Stepper Trace */}
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-[10px] whitespace-nowrap">
                  <div className="bg-white px-2.5 py-1.5 rounded border border-slate-200">
                    <span className="font-bold text-slate-400 uppercase mr-1.5">Lead:</span>
                    <span className="font-mono font-semibold text-slate-800">{item.leadId}</span>
                  </div>
                  <span className="text-slate-500 text-base font-black mx-1">→</span>
                  <div className="bg-white px-2.5 py-1.5 rounded border border-slate-200">
                    <span className="font-bold text-slate-400 uppercase mr-1.5">Proposal:</span>
                    <span className="font-semibold text-slate-800">{item.customerName}</span>
                  </div>
                  <span className="text-slate-500 text-base font-black mx-1">→</span>
                  <div className="bg-white px-2.5 py-1.5 rounded border border-slate-200">
                    <span className="font-bold text-slate-400 uppercase mr-1.5">Underwriting:</span>
                    <span className="font-semibold text-blue-700">Approved (NML Passed)</span>
                  </div>
                  <span className="text-slate-500 text-base font-black mx-1">→</span>
                  <div className="bg-white px-2.5 py-1.5 rounded border border-slate-200">
                    <span className="font-bold text-slate-400 uppercase mr-1.5">Policy:</span>
                    <span className="font-mono font-semibold text-blue-700">{item.policyNumber}</span>
                  </div>
                  <span className="text-slate-500 text-base font-black mx-1">→</span>
                  <div className="bg-white px-2.5 py-1.5 rounded border border-slate-200">
                    <span className="font-bold text-slate-400 uppercase mr-1.5">Cash:</span>
                    <span className="font-mono font-semibold text-blue-700">{fmtPKR(item.collectedPremium)}</span>
                  </div>
                  <span className="text-slate-500 text-base font-black mx-1">→</span>
                  <div className="bg-white px-2.5 py-1.5 rounded border border-slate-200">
                    <span className="font-bold text-slate-400 uppercase mr-1.5">Ledger:</span>
                    <span className="font-mono font-extrabold text-blue-900">{item.id}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── RULE 62 CLAWBACK MODAL ─────────────────────────────────────────────── */}
      {activeClawbackEntry && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs px-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg border border-slate-200 overflow-hidden">
            <div className="bg-slate-900 px-6 py-4 flex items-center justify-between text-white">
              <div>
                <h3 className="font-bold text-sm">Clawback Commission</h3>
                <p className="text-xs text-slate-200 font-mono mt-0.5">Policy: {activeClawbackEntry.policyNumber}</p>
              </div>
              <button onClick={() => setActiveClawbackEntry(null)} className="text-white/60 hover:text-white text-lg">✕</button>
            </div>

            <div className="p-6 space-y-4 text-xs">
              <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl text-slate-900 space-y-1">
                <p className="font-bold">Reversal Amount: {fmtPKR(activeClawbackEntry.netCommission)}</p>
                <p className="text-[11px]">This will reverse the commission.</p>
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Clawback / Reversal Reason Code</label>
                <select
                  value={clawbackReasonInput}
                  onChange={(e) => setClawbackReasonInput(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded-xl bg-white text-xs"
                >
                  <option value="Policy Cancelled under SECP 14-Day Free-Look Period (Rule 62)">SECP 14-Day Free-Look Cancellation (Rule 62)</option>
                  <option value="Policy Lapsed due to Non-Payment of Renewal Premium">Policy Lapsed (Non-Payment of Renewal)</option>
                  <option value="Underwriting Rejection / Misrepresentation">Underwriting Material Misrepresentation</option>
                  <option value="Proposer Chargeback Request">Proposer Bank Chargeback / Cheque Bounce</option>
                </select>
              </div>
            </div>

            <div className="border-t border-slate-200 px-6 py-3 flex justify-end gap-2 bg-slate-50">
              <button
                onClick={() => setActiveClawbackEntry(null)}
                className="px-4 py-2 bg-white border border-slate-300 font-bold rounded-xl text-slate-700 text-xs hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={handleExecuteClawback}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-800 text-white font-bold rounded-xl text-xs shadow-md"
              >
                Execute Clawback &amp; Reversal
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
