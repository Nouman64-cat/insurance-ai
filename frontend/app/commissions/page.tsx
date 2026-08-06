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
  disburseCommission,
  triggerClawback,
  calculateCommissionForPolicy,
  PremiumType,
  PolicySegment,
} from "../services/commissions";

export default function CommissionsPage() {
  const [activeTab, setActiveTab] = useState<"ledger" | "calculator" | "rules" | "tracing">("ledger");
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
        policyId: `POL-${Math.floor(10000 + Math.random() * 90000)}`,
        policyNumber: `POL-ADAM-${Math.floor(10000 + Math.random() * 90000)}`,
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
      setActiveTab("ledger");
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
          className={`fixed top-5 right-5 z-50 px-4 py-3 rounded-xl shadow-xl border text-xs font-bold flex items-center gap-2 animate-in slide-in-from-top-2 ${
            notification.type === "success"
              ? "bg-emerald-900 text-emerald-100 border-emerald-700"
              : "bg-rose-900 text-rose-100 border-rose-700"
          }`}
        >
          <span>{notification.type === "success" ? "✓" : "✕"}</span>
          <span>{notification.msg}</span>
        </div>
      )}

      {/* Header & Regulatory Compliance Banner */}
      <div className="bg-gradient-to-r from-purple-900 via-indigo-900 to-slate-900 rounded-2xl p-6 text-white shadow-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-black tracking-tight">Agent Commission &amp; Remuneration Hub</h1>
            <span className="px-2.5 py-0.5 rounded-full bg-purple-500/20 border border-purple-400/40 text-purple-200 font-mono text-[10px] font-bold">
              SECP Insurance Rules 2017
            </span>
          </div>
          <p className="text-xs text-purple-200/90 mt-1 max-w-3xl">
            Statutory commission processing engine adhering to SECP Rule 24, Rule 58 (Premium Realization Gating), Rule 62 (Free-Look Clawbacks), Form LG, and Adamjee Life 2024 Reporting Standards.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/underwriting"
            className="px-3.5 py-2 bg-white/10 hover:bg-white/20 border border-white/20 text-white rounded-xl text-xs font-bold transition-all"
          >
            ← Back to Underwriting
          </Link>
          <button
            onClick={() => setActiveTab("calculator")}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-xs font-bold shadow-lg transition-all flex items-center gap-1.5"
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
            <div className="flex items-center justify-between text-slate-500 text-[11px] font-semibold">
              <span>Gross Commission Pool</span>
              <span className="text-purple-600 font-mono">SECP Form LG</span>
            </div>
            <p className="text-xl font-extrabold text-slate-900 font-mono">{fmtPKR(stats.totalGrossCommission)}</p>
            <p className="text-[10px] text-slate-400">Total recognized variable acquisition cost</p>
          </div>

          <div className="bg-white p-4 rounded-2xl border border-purple-200 shadow-xs space-y-1">
            <div className="flex items-center justify-between text-purple-900 text-[11px] font-semibold">
              <span>Accrued Payable Ledger</span>
              <span className="px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded text-[9px] font-bold">Form LA</span>
            </div>
            <p className="text-xl font-extrabold text-purple-700 font-mono">{fmtPKR(stats.totalAccruedLiability)}</p>
            <p className="text-[10px] text-slate-400">Balance sheet agent payable liability</p>
          </div>

          <div className="bg-white p-4 rounded-2xl border border-emerald-200 shadow-xs space-y-1">
            <div className="flex items-center justify-between text-emerald-800 text-[11px] font-semibold">
              <span>Disbursed Net Payout</span>
              <span className="text-emerald-600 font-bold text-[10px]">✓ Bank Settled</span>
            </div>
            <p className="text-xl font-extrabold text-emerald-700 font-mono">{fmtPKR(stats.totalDisbursed)}</p>
            <p className="text-[10px] text-slate-400">Net of 10% SECP Withholding Tax (WHT)</p>
          </div>

          <div className="bg-white p-4 rounded-2xl border border-rose-200 shadow-xs space-y-1">
            <div className="flex items-center justify-between text-rose-800 text-[11px] font-semibold">
              <span>Clawbacks &amp; Reversals</span>
              <span className="px-1.5 py-0.5 bg-rose-100 text-rose-700 rounded text-[9px] font-bold">Rule 62</span>
            </div>
            <p className="text-xl font-extrabold text-rose-700 font-mono">{fmtPKR(stats.totalClawbacks)}</p>
            <p className="text-[10px] text-slate-400">Lapse &amp; 14-day Free-Look cancellations</p>
          </div>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="border-b border-slate-200 flex gap-2">
        <button
          onClick={() => setActiveTab("ledger")}
          className={`pb-3 px-4 font-bold text-xs border-b-2 transition-all ${
            activeTab === "ledger"
              ? "border-purple-600 text-purple-700"
              : "border-transparent text-slate-500 hover:text-slate-800"
          }`}
        >
          Commission Ledger &amp; Payout Gate ({ledger.length})
        </button>
        <button
          onClick={() => setActiveTab("calculator")}
          className={`pb-3 px-4 font-bold text-xs border-b-2 transition-all ${
            activeTab === "calculator"
              ? "border-purple-600 text-purple-700"
              : "border-transparent text-slate-500 hover:text-slate-800"
          }`}
        >
          Interactive Rating &amp; Accrual Modeler
        </button>
        <button
          onClick={() => setActiveTab("rules")}
          className={`pb-3 px-4 font-bold text-xs border-b-2 transition-all ${
            activeTab === "rules"
              ? "border-purple-600 text-purple-700"
              : "border-transparent text-slate-500 hover:text-slate-800"
          }`}
        >
          SECP Statutory Rate Card Matrix
        </button>
        <button
          onClick={() => setActiveTab("tracing")}
          className={`pb-3 px-4 font-bold text-xs border-b-2 transition-all ${
            activeTab === "tracing"
              ? "border-purple-600 text-purple-700"
              : "border-transparent text-slate-500 hover:text-slate-800"
          }`}
        >
          Lead-to-Agent Traceability Lifecycle
        </button>
      </div>

      {/* ── TAB 1: COMMISSION LEDGER & PAYOUT GATE ────────────────────────────── */}
      {activeTab === "ledger" && (
        <div className="space-y-4">
          {/* Search & Filter Control Bar */}
          <div className="bg-white p-4 rounded-xl border border-slate-200 flex flex-wrap gap-3 items-center justify-between">
            <div className="flex items-center gap-3 flex-1 min-w-[280px]">
              <input
                type="text"
                placeholder="Search Agent, Customer, Policy #, or Lead ID..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-1.5 text-xs text-slate-800 focus:outline-hidden focus:border-purple-500"
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
                    <th className="p-3">Ref ID &amp; Lead ID</th>
                    <th className="p-3">Agent Name &amp; Code</th>
                    <th className="p-3">Policy &amp; Customer</th>
                    <th className="p-3">Premium Type &amp; Rate</th>
                    <th className="p-3">Collected Premium</th>
                    <th className="p-3">Gross / WHT (10%)</th>
                    <th className="p-3">Net Commission</th>
                    <th className="p-3">Status &amp; Gating (Rule 58)</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-800">
                  {filteredLedger.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="p-3">
                        <p className="font-mono font-bold text-purple-900">{item.id}</p>
                        <span className="text-[10px] text-slate-400 font-mono">Trace: {item.leadId}</span>
                      </td>
                      <td className="p-3">
                        <p className="font-bold text-slate-900">{item.agentName}</p>
                        <p className="text-[10px] font-mono text-slate-400">{item.agentCode}</p>
                      </td>
                      <td className="p-3">
                        <p className="font-semibold text-slate-800">{item.customerName}</p>
                        <p className="text-[10px] font-mono text-purple-700">{item.policyNumber}</p>
                        <span className="text-[9px] uppercase px-1.5 py-0.2 rounded bg-slate-100 font-bold text-slate-500">
                          {item.segment}
                        </span>
                      </td>
                      <td className="p-3">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-extrabold border ${
                            item.premiumType === "FIRST_YEAR"
                              ? "bg-purple-50 text-purple-700 border-purple-200"
                              : item.premiumType === "RENEWAL"
                              ? "bg-blue-50 text-blue-700 border-blue-200"
                              : "bg-amber-50 text-amber-800 border-amber-200"
                          }`}
                        >
                          {item.premiumType.replace("_", " ")} (Yr {item.policyYear})
                        </span>
                        <p className="text-[10px] font-bold text-slate-600 mt-1">Rate: {item.ratePct}%</p>
                      </td>
                      <td className="p-3 font-mono font-bold text-slate-800">
                        {fmtPKR(item.collectedPremium)}
                      </td>
                      <td className="p-3 font-mono text-[11px]">
                        <p className="font-bold text-slate-900">{fmtPKR(item.grossCommission)}</p>
                        <p className="text-slate-400 text-[10px]">- WHT: {fmtPKR(item.whtTax)}</p>
                      </td>
                      <td className="p-3 font-mono font-extrabold text-emerald-700 text-sm">
                        {fmtPKR(item.netCommission)}
                      </td>
                      <td className="p-3">
                        <div className="space-y-1">
                          <span
                            className={`px-2.5 py-0.5 rounded-full text-[10px] font-extrabold border inline-block ${
                              item.status === "DISBURSED"
                                ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                                : item.status === "PAYABLE"
                                ? "bg-purple-100 text-purple-800 border-purple-300"
                                : item.status === "CLAWED_BACK"
                                ? "bg-rose-100 text-rose-800 border-rose-300"
                                : "bg-slate-100 text-slate-700 border-slate-300"
                            }`}
                          >
                            {item.status}
                          </span>
                          <p className="text-[10px] text-slate-500 leading-tight max-w-[200px]">
                            {item.gatingReason}
                          </p>
                        </div>
                      </td>
                      <td className="p-3 text-right space-x-1">
                        {item.status === "PAYABLE" && (
                          <button
                            onClick={() => handleDisburse(item.id)}
                            className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px] rounded-lg shadow-2xs transition-colors"
                          >
                            Disburse →
                          </button>
                        )}
                        {item.status !== "CLAWED_BACK" && (
                          <button
                            onClick={() => setActiveClawbackEntry(item)}
                            className="px-2 py-1 bg-white hover:bg-rose-50 border border-slate-200 text-rose-700 font-bold text-[10px] rounded-lg transition-colors"
                          >
                            Rule 62 Clawback
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── TAB 2: INTERACTIVE RATING & ACCRUAL MODELER ───────────────────────── */}
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
                className="px-5 py-2.5 bg-purple-700 hover:bg-purple-800 text-white font-bold text-xs rounded-xl shadow-md transition-all"
              >
                Accrue Commission to Ledger →
              </button>
            </div>
          </div>

          {/* Real-time Calculation Breakdown Preview */}
          <div className="bg-slate-900 text-white p-6 rounded-2xl shadow-xl space-y-4 border border-slate-800 flex flex-col justify-between">
            <div className="space-y-3">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                <h3 className="font-bold text-xs text-purple-200 uppercase tracking-wider">
                  Commission Computation Result
                </h3>
                <span className="px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 font-mono text-[10px] font-bold">
                  Rule 24 Matched
                </span>
              </div>

              <div className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-400">Applicable Rate:</span>
                  <span className="font-mono font-bold text-purple-300">{currentRule.ratePct}%</span>
                </div>

                <div className="flex justify-between">
                  <span className="text-slate-400">Gross Commission:</span>
                  <span className="font-mono font-bold text-white">{fmtPKR(calcGross)}</span>
                </div>

                <div className="flex justify-between text-rose-300">
                  <span>SECP WHT Deduction (10%):</span>
                  <span className="font-mono font-bold">- {fmtPKR(calcWht)}</span>
                </div>

                <div className="pt-3 border-t border-slate-800 flex justify-between items-center">
                  <span className="font-bold text-slate-300">Net Payable Commission:</span>
                  <span className="font-mono font-black text-emerald-400 text-lg">{fmtPKR(calcNet)}</span>
                </div>
              </div>
            </div>

            <div className="bg-slate-800/80 p-3 rounded-xl border border-slate-700/60 text-[10px] text-slate-400 space-y-1">
              <p className="font-bold text-slate-300">Gating Compliance Note (SECP Rule 58):</p>
              <p>Commission becomes payable upon underwriting completion &amp; cash payment confirmation in treasury.</p>
            </div>
          </div>
        </div>
      )}

      {/* ── TAB 3: SECP STATUTORY RATE CARD MATRIX ────────────────────────────── */}
      {activeTab === "rules" && (
        <div className="bg-white p-6 rounded-2xl border border-slate-200 space-y-4 shadow-xs">
          <div>
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
              Statutory Commission Matrix (SECP Rules 2017 &amp; Adamjee Life Standards)
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Standardized regulatory reporting structure for intermediary remuneration split by segment, premium category, and policy duration.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-2">
            {SECP_DEFAULT_RULES.map((rule) => (
              <div key={rule.id} className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
                <div className="flex justify-between items-start">
                  <span className="px-2 py-0.5 rounded bg-purple-100 text-purple-800 font-bold text-[10px] uppercase">
                    {rule.segment}
                  </span>
                  <span className="font-mono text-lg font-black text-purple-900">{rule.ratePct}%</span>
                </div>
                <h3 className="font-bold text-slate-800 text-xs">{rule.description}</h3>
                <p className="text-[10px] text-slate-500 font-mono">
                  {rule.premiumType.replace("_", " ")} · Year {rule.policyYear}
                </p>
                <div className="pt-2 border-t border-slate-200/80 flex items-center justify-between text-[9px] text-slate-400">
                  <span>Reference:</span>
                  <span className="font-bold text-purple-700">{rule.secpRef}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── TAB 4: LEAD-TO-AGENT TRACEABILITY LIFECYCLE ───────────────────────── */}
      {activeTab === "tracing" && (
        <div className="bg-white p-6 rounded-2xl border border-slate-200 space-y-6 shadow-xs">
          <div>
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
              End-to-End Lead-to-Agent Commission Traceability Lifecycle
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Auditability matrix mapping every prospect lead to agent code, policy binding, cash realization, and commission payable ledger.
            </p>
          </div>

          <div className="space-y-4">
            {ledger.map((item) => (
              <div key={item.id} className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
                <div className="flex flex-wrap justify-between items-center gap-2 border-b border-slate-200 pb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-xs text-purple-900">{item.leadId}</span>
                    <span className="text-slate-400">➔</span>
                    <span className="font-bold text-xs text-slate-800">{item.agentName} ({item.agentCode})</span>
                    <span className="text-slate-400">➔</span>
                    <span className="font-mono font-bold text-xs text-purple-700">{item.policyNumber}</span>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-mono font-bold text-xs">
                    Payout: {fmtPKR(item.netCommission)}
                  </span>
                </div>

                {/* 5-Step Stepper Trace */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center text-[10px]">
                  <div className="bg-white p-2 rounded-lg border border-slate-200">
                    <p className="font-bold text-slate-400 uppercase">1. Lead Assigned</p>
                    <p className="font-mono font-semibold text-slate-800">{item.leadId}</p>
                  </div>
                  <div className="bg-white p-2 rounded-lg border border-slate-200">
                    <p className="font-bold text-slate-400 uppercase">2. Proposal Bound</p>
                    <p className="font-semibold text-slate-800">{item.customerName}</p>
                  </div>
                  <div className="bg-white p-2 rounded-lg border border-slate-200">
                    <p className="font-bold text-slate-400 uppercase">3. Policy Issued</p>
                    <p className="font-mono font-semibold text-purple-700">{item.policyNumber}</p>
                  </div>
                  <div className="bg-white p-2 rounded-lg border border-slate-200">
                    <p className="font-bold text-slate-400 uppercase">4. Cash Realized</p>
                    <p className="font-mono font-semibold text-emerald-700">{fmtPKR(item.collectedPremium)}</p>
                  </div>
                  <div className="bg-white p-2 rounded-lg border border-slate-200">
                    <p className="font-bold text-slate-400 uppercase">5. Commission Ledger</p>
                    <p className="font-mono font-extrabold text-purple-900">{item.id}</p>
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
            <div className="bg-rose-900 px-6 py-4 flex items-center justify-between text-white">
              <div>
                <h3 className="font-bold text-sm">SECP Rule 62 Commission Clawback &amp; Reversal</h3>
                <p className="text-xs text-rose-200 font-mono mt-0.5">Policy: {activeClawbackEntry.policyNumber}</p>
              </div>
              <button onClick={() => setActiveClawbackEntry(null)} className="text-white/60 hover:text-white text-lg">✕</button>
            </div>

            <div className="p-6 space-y-4 text-xs">
              <div className="bg-rose-50 border border-rose-200 p-3 rounded-xl text-rose-900 space-y-1">
                <p className="font-bold">Reversal Amount: {fmtPKR(activeClawbackEntry.netCommission)}</p>
                <p className="text-[11px]">Executing this clawback will reverse the agent payable ledger and generate an automatic debit note against future commission disbursements.</p>
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
                className="px-4 py-2 bg-rose-700 hover:bg-rose-800 text-white font-bold rounded-xl text-xs shadow-md"
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
