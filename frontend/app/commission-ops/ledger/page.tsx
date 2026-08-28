"use client";
import React, { useState, useCallback, useEffect } from "react";
import LedgerTab from "../../../components/commissions/LedgerTab";
import {
  CommissionLedgerEntry,
  listCommissionLedger,
  disburseCommission,
  recordPolicyEvent
} from "../../services/commissions";
import {
  DateRangeFilter,
  resolvePreset,
  type DatePreset,
  type DateRange,
} from "../../../components/commissions/DateRangeFilter";

export default function LedgerPage() {
  const [datePreset, setDatePreset] = useState<DatePreset>("30d");
  const [dateRange, setDateRange] = useState<DateRange>(() => resolvePreset("30d"));
  const [notification, setNotification] = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const [ledger, setLedger] = useState<CommissionLedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const notify = useCallback((msg: string, ok = true) => {
    setNotification({ msg, type: ok ? "success" : "error" });
    setTimeout(() => setNotification(null), 4500);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const ledgerData = await listCommissionLedger();
      setLedger([...ledgerData]);
    } catch (err) {
      notify("Could not load ledger.", false);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 space-y-6">
      {notification && (
        <div className={`fixed top-5 right-5 z-50 max-w-md px-4 py-3 rounded-xl shadow-lg border text-xs font-bold flex items-start gap-2 bg-white text-slate-800 ${notification.type === "success" ? "border-blue-200 text-blue-900" : "border-rose-200 text-rose-800"}`}>
          <span className={notification.type === "success" ? "text-blue-600" : "text-rose-600"}>{notification.type === "success" ? "✓" : "✕"}</span>
          <span>{notification.msg}</span>
        </div>
      )}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Accrual Feed</h1>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Real-time ledger of policy accruals, status changes, and disburse triggers
          </p>
        </div>
        <DateRangeFilter
          preset={datePreset}
          range={dateRange}
          onPresetChange={(p, r) => {
            setDatePreset(p);
            setDateRange(r);
          }}
          align="right"
        />
      </div>
      {loading && ledger.length === 0 ? (
         <div className="px-5 py-12 text-center text-xs text-slate-400 bg-white rounded-xl shadow-sm border border-slate-200">Loading ledger...</div>
      ) : (
         <LedgerTab
           ledger={ledger}
           datePreset={datePreset}
           dateRange={dateRange}
           onDateChange={(p, r) => {
             setDatePreset(p);
             setDateRange(r);
           }}
           onDisburse={async (id, stage) => { await disburseCommission(id, stage); refresh(); }}
           onHold={(entry) => console.log("Hold initiated", entry)}
           onClawback={(entry) => console.log("Clawback initiated", entry)}
           onRecordEvent={async (id, ev) => { await recordPolicyEvent(id, ev); refresh(); }}
         />
      )}
    </div>
  );
}
