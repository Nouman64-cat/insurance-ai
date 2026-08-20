"use client";
import React, { useState, useEffect, useCallback } from "react";
import { CommissionHoldbackLien, listHoldbacks } from "../../services/commissions";

export default function HoldbacksPage() {
  const [holdbacks, setHoldbacks] = useState<CommissionHoldbackLien[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listHoldbacks();
      setHoldbacks(data);
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
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Holdbacks & Lien</h1>
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-800 border border-purple-200">Disbursement & Treasury</span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Manage administrative holds and statutory liens on payee payouts.
          </p>
        </div>
        <div className="flex items-center gap-2">
           <button className="text-xs font-semibold px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 shadow-sm transition-colors flex items-center gap-1.5">
             <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
               <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
             </svg>
             Create Holdback
           </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
          <h2 className="text-sm font-bold text-slate-800">Active Holds & Recoveries</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-100 text-xs">
              <tr>
                <th className="px-5 py-3 font-semibold">Holdback ID / Category</th>
                <th className="px-5 py-3 font-semibold">Payee</th>
                <th className="px-5 py-3 font-semibold text-right">Withholding %</th>
                <th className="px-5 py-3 font-semibold text-right">Recovery Progress</th>
                <th className="px-5 py-3 font-semibold">Status / Authorized By</th>
                <th className="px-5 py-3 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-slate-400 text-xs">Loading holdbacks...</td></tr>
              ) : holdbacks.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-slate-400 text-xs">No active holdbacks found.</td></tr>
              ) : (
                holdbacks.map((h) => (
                  <tr key={h.holdbackId} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-5 py-3">
                      <div className="font-medium text-slate-900">{h.category.replace(/_/g, ' ')}</div>
                      <div className="text-[10px] text-slate-400 font-mono">{h.holdbackId}</div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="font-medium text-slate-900">{h.payeeId}</div>
                      <div className="text-[10px] text-slate-500 max-w-[150px] truncate">{h.reasonNotes}</div>
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="font-bold text-rose-600">{h.withholdingPercentage}%</div>
                      <div className="text-[10px] text-slate-400">of Net Payout</div>
                    </td>
                    <td className="px-5 py-3 text-right">
                      {h.targetAmount ? (
                        <>
                          <div className="font-bold text-slate-900">Rs. {h.accumulatedRecovered.toLocaleString()}</div>
                          <div className="text-[10px] text-slate-400">of Rs. {h.targetAmount.toLocaleString()}</div>
                          <div className="w-full bg-slate-100 rounded-full h-1.5 mt-1 overflow-hidden">
                             <div className="bg-emerald-500 h-1.5 rounded-full" style={{ width: `${(h.accumulatedRecovered / h.targetAmount) * 100}%` }}></div>
                          </div>
                        </>
                      ) : (
                        <div className="text-xs text-slate-500 italic">Indefinite Hold</div>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        h.status === 'ACTIVE' ? 'bg-amber-100 text-amber-800' :
                        h.status === 'FULFILLED' ? 'bg-emerald-100 text-emerald-800' :
                        'bg-slate-100 text-slate-800'
                      }`}>
                        {h.status}
                      </span>
                      <div className="text-[10px] text-slate-400 mt-1">{h.authorizedBy}</div>
                    </td>
                    <td className="px-5 py-3">
                      {h.status === 'ACTIVE' && (
                        <button className="text-[10px] font-semibold px-3 py-1.5 border border-slate-200 rounded-md text-slate-600 hover:bg-slate-100 transition-colors">Clear Hold</button>
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
