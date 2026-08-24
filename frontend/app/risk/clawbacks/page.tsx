"use client";
import React, { useState, useEffect, useCallback } from "react";
import { ClawbackTransaction, listClawbacks } from "../../services/commissions";
import DemoDataBanner from "@/components/DemoDataBanner";

export default function ClawbackEnginePage() {
  const [clawbacks, setClawbacks] = useState<ClawbackTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listClawbacks();
      setClawbacks(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 space-y-6">
      <DemoDataBanner note="This module has no backend yet. These recoveries are generated in the browser against real payee records — no debit has been raised against anyone." />
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Clawback Engine</h1>
            {/* <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">Risk & Regulatory</span> */}
          </div>
          {/* <p className="text-xs text-slate-500 mt-1">
            Automated recoveries for policy cancellations, chargebacks, and lapses.
          </p> */}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 flex flex-col justify-between">
          <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">14-Day Free-Look Recoveries</div>
          <div className="text-2xl font-bold text-slate-900">100% FYC</div>
          <div className="text-xs text-slate-400 mt-1">Immediate reversal of First-Year Commission</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 flex flex-col justify-between">
          <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Multi-Tier Cascade Engine</div>
          <div className="text-xs text-slate-600 space-y-1">
            <div className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-slate-400"></span> <span>Agent Split Reversal</span></div>
            <div className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-slate-400"></span> <span>Unit Manager Override Reversal</span></div>
            <div className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-slate-400"></span> <span>Branch Manager Override Reversal</span></div>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
          <h2 className="text-sm font-bold text-slate-800">Cascade Debit Notes & Recoveries</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-100 text-xs">
              <tr>
                <th className="px-5 py-3 font-semibold">Policy / Trigger</th>
                <th className="px-5 py-3 font-semibold">Hierarchy Target</th>
                <th className="px-5 py-3 font-semibold text-right">Gross Reversal</th>
                <th className="px-5 py-3 font-semibold text-right">Tax Adj (WHT)</th>
                <th className="px-5 py-3 font-semibold text-right">Net Debit</th>
                <th className="px-5 py-3 font-semibold">Recovery Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-slate-400 text-xs">Loading clawbacks...</td></tr>
              ) : clawbacks.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-slate-400 text-xs">No clawback transactions found.</td></tr>
              ) : (
                clawbacks.map((c) => (
                  <tr key={c.clawbackId} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-5 py-3">
                      <div className="font-medium text-slate-900">{c.policyNumber}</div>
                      <div className="text-[10px] text-rose-600 font-bold">{c.clawbackTrigger.replace(/_/g, ' ')}</div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="font-medium text-slate-900">{c.payeeId}</div>
                      <div className="text-[10px] text-slate-500 font-mono">{c.roleInHierarchy}</div>
                    </td>
                    <td className="px-5 py-3 text-right text-rose-600 font-medium">
                      (Rs. {c.grossClawbackAmount.toLocaleString()})
                    </td>
                    <td className="px-5 py-3 text-right text-emerald-600 font-medium">
                      +Rs. {c.taxAdjustmentAmount.toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="font-bold text-rose-700">(Rs. {c.netDebitAmount.toLocaleString()})</div>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${c.recoveryStatus === 'FULLY_RECOVERED' ? 'bg-emerald-100 text-emerald-800' :
                          c.recoveryStatus === 'CARRIED_FORWARD_DEBT' ? 'bg-rose-100 text-rose-800' :
                            'bg-amber-100 text-amber-800'
                        }`}>
                        {c.recoveryStatus.replace(/_/g, ' ')}
                      </span>
                      {c.recoveryStatus === 'CARRIED_FORWARD_DEBT' && (
                        <div className="text-[10px] text-slate-400 mt-1">Pending next payout run</div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
