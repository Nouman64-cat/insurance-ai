"use client";

import React, { useCallback, useEffect, useState } from "react";
import IncentivesTab from "../../../components/commissions/IncentivesTab";
import {
  INCENTIVE_SCHEMES,
  IncentiveQualification,
  evaluateIncentives,
  listCommissionLedger,
  listPayees,
} from "../../services/commissions";
import { fmtPKR } from "../../../components/commissions/shared";


export default function BonusesPage() {
  const [notification, setNotification] = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const [qualifications, setQualifications] = useState<IncentiveQualification[]>([]);
  const [loading, setLoading] = useState(true);

  const notify = useCallback((msg: string, ok = true) => {
    setNotification({ msg, type: ok ? "success" : "error" });
    setTimeout(() => setNotification(null), 4500);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [payees, ledger] = await Promise.all([listPayees(), listCommissionLedger()]);
      setQualifications(evaluateIncentives(payees, ledger));
    } catch (err) {
      notify("Could not load bonuses.", false);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const activePlansCount = INCENTIVE_SCHEMES.filter((s) => s.active).length;
  const qualifiedList = qualifications.filter((q) => q.qualifies && q.awardAmount > 0);
  const totalEarnedAmount = qualifiedList.reduce((s, q) => s + q.awardAmount, 0);
  const shortfallCount = qualifications.filter((q) => !q.qualifies).length;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 space-y-6">
      {notification && (
        <div
          className={`fixed top-5 right-5 z-50 max-w-md px-4 py-3 rounded-xl shadow-lg border text-xs font-bold flex items-start gap-2.5 bg-white backdrop-blur-xs transition-all ${
            notification.type === "success"
              ? "border-blue-200 text-blue-900 shadow-blue-500/5"
              : "border-rose-200 text-rose-800 shadow-rose-500/5"
          }`}
        >
          <span
            className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-xs font-extrabold ${
              notification.type === "success" ? "bg-blue-100 text-blue-700" : "bg-rose-100 text-rose-700"
            }`}
          >
            {notification.type === "success" ? "✓" : "✕"}
          </span>
          <span className="mt-0.5">{notification.msg}</span>
        </div>
      )}

      {/* Page Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-200/80 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-extrabold tracking-tight text-slate-900">Performance Bonuses</h1>
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-extrabold bg-blue-50 text-blue-700 border border-blue-200">
              Incentive Engine
            </span>
          </div>
        </div>
      </div>


      {loading && qualifications.length === 0 ? (
        <div className="px-5 py-12 text-center text-xs text-slate-400 bg-white rounded-xl shadow-xs border border-slate-200">
          Loading performance incentives…
        </div>
      ) : (
        <IncentivesTab qualifications={qualifications} onChanged={refresh} notify={notify} />
      )}
    </div>
  );
}
