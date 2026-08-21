"use client";
import React, { useState, useEffect, useCallback } from "react";
import { SettlementRecord, listSettlementRecords } from "../../services/commissions";

export default function SettlementPage() {
  const [records, setRecords] = useState<SettlementRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listSettlementRecords();
      setRecords(data);
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
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Payment Settlement</h1>
            {/* <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-800 border border-purple-200">Disbursement & Treasury</span> */}
          </div>
          {/* <p className="text-xs text-slate-500 mt-1">
            Reconcile cleared funds and execution receipts from the banking gateway.
          </p> */}
        </div>
        <div className="flex items-center gap-2">
          <button className="text-xs font-semibold px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 shadow-sm transition-colors flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Ingest MT940 File
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
          <h2 className="text-sm font-bold text-slate-800">Reconciliation & Exceptions Desk</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-100 text-xs">
              <tr>
                <th className="px-5 py-3 font-semibold">Settlement ID</th>
                <th className="px-5 py-3 font-semibold">Payee / Line Item</th>
                <th className="px-5 py-3 font-semibold">Bank Reference</th>
                <th className="px-5 py-3 font-semibold">Clearing Date</th>
                <th className="px-5 py-3 font-semibold">Status</th>
                <th className="px-5 py-3 font-semibold">Exception/Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-slate-400 text-xs">Loading settlement records...</td></tr>
              ) : records.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-slate-400 text-xs">No settlement records found.</td></tr>
              ) : (
                records.map((r) => (
                  <tr key={r.settlementId} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-5 py-3">
                      <div className="font-medium text-slate-900">{r.settlementId}</div>
                      <div className="text-[10px] text-slate-400 font-mono">{r.batchId}</div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="font-medium text-slate-900">{r.payeeId}</div>
                      <div className="text-[10px] text-slate-400 font-mono">{r.lineItemId}</div>
                    </td>
                    <td className="px-5 py-3 text-xs font-mono text-slate-600">{r.bankReferenceNumber}</td>
                    <td className="px-5 py-3 text-xs text-slate-600">
                      {new Date(r.clearingDate).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${r.status === 'CLEARED' ? 'bg-emerald-100 text-emerald-800' :
                        r.status === 'BOUNCED' ? 'bg-rose-100 text-rose-800' :
                          'bg-amber-100 text-amber-800'
                        }`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      {r.status === 'BOUNCED' ? (
                        <div>
                          <div className="text-xs font-bold text-rose-700">{r.returnReasonCode}</div>
                          <div className="text-[10px] text-slate-500">{r.returnReasonDescription}</div>
                          <button className="mt-1 text-[10px] font-semibold text-purple-600 hover:text-purple-800 underline">Rollback to Unpaid</button>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">None</span>
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
