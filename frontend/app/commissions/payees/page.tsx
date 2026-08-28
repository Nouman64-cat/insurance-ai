"use client";
import React, { useState, useCallback, useEffect } from "react";
import PayeesTab from "../../../components/commissions/PayeesTab";
import { CommissionPayee, listPayees } from "../../services/commissions";
import { DateRangeFilter, resolvePreset, type DatePreset, type DateRange } from "../../../components/commissions/DateRangeFilter";

export default function PayeesPage() {
  const [notification, setNotification] = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const [payees, setPayees] = useState<CommissionPayee[]>([]);
  const [loading, setLoading] = useState(true);
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [dateRange, setDateRange] = useState<DateRange>(() => resolvePreset("all"));

  const notify = useCallback((msg: string, ok = true) => {
    setNotification({ msg, type: ok ? "success" : "error" });
    setTimeout(() => setNotification(null), 4500);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const payeeData = await listPayees();
      setPayees([...payeeData]);
    } catch (err) {
      notify("Could not load payees.", false);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Roles</h1>
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-800 border border-blue-200">Payees &amp; Hierarchy</span>
          </div>
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
      {loading && payees.length === 0 ? (
        <div className="px-5 py-12 text-center text-xs text-slate-400 bg-white rounded-xl shadow-sm border border-slate-200">Loading payees...</div>
      ) : (
        <PayeesTab
          payees={payees}
          datePreset={datePreset}
          dateRange={dateRange}
          onDateChange={(p, r) => {
            setDatePreset(p);
            setDateRange(r);
          }}
          onChanged={refresh}
          notify={notify}
        />
      )}
    </div>
  );
}
