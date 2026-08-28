"use client";

import React, { useCallback, useEffect, useState } from "react";
import { COMMISSION_RATE_CARD } from "../../../app/services/commissions";
import RateCardTab from "../../../components/commissions/RateCardTab";

export default function TypesPage() {
  const [notification, setNotification] = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const [stats, setStats] = useState({
    total: 0,
    active: 0,
    statutory: 0,
    channels: 0,
  });

  const updateStats = useCallback(() => {
    const total = COMMISSION_RATE_CARD.length;
    const active = COMMISSION_RATE_CARD.filter((r) => r.active).length;
    const statutory = COMMISSION_RATE_CARD.filter((r) => r.refStatus === "STATUTORY").length;
    const channels = new Set(COMMISSION_RATE_CARD.map((r) => r.channel)).size;
    setStats({ total, active, statutory, channels });
  }, []);

  useEffect(() => {
    updateStats();
  }, [updateStats]);

  const notify = useCallback(
    (msg: string, ok = true) => {
      setNotification({ msg, type: ok ? "success" : "error" });
      updateStats();
      setTimeout(() => setNotification(null), 4500);
    },
    [updateStats],
  );

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
            <h1 className="text-xl font-extrabold tracking-tight text-slate-900">Commission Types</h1>
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-extrabold bg-blue-50 text-blue-700 border border-blue-200">
              Rate Cards &amp; Engine Rules
            </span>
          </div>
 
        </div>
      </div>


      <RateCardTab notify={notify} />
    </div>
  );
}
