"use client";
import React, { useState, useEffect, useCallback } from "react";
import { PayoutDispatchBatch, listPayoutDispatchBatches } from "../../services/commissions";
import DemoDataBanner from "@/components/DemoDataBanner";
import { Pagination, usePagination } from "@/components/Pagination";
import { tx } from "@/lib/i18n/tx";

export default function BankingGatewayPage() {
  const [batches, setBatches] = useState<PayoutDispatchBatch[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listPayoutDispatchBatches();
      setBatches(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const { pageItems: pagedBatches, pagination } = usePagination(batches);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 space-y-6">
      <DemoDataBanner />
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">{tx("Banking Gateway")}</h1>
            {/* <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-800 border border-blue-200">Disbursement & Treasury</span> */}
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {tx("Manage API integrations for 1LINK, Raast, and multi-bank settlement rails.")}
          </p>
        </div>
        <div className="flex items-center gap-2">
           <button onClick={refresh} className="text-xs font-semibold px-4 py-2 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 shadow-sm transition-colors text-slate-700">{tx("Refresh Endpoints")}</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 flex flex-col justify-between">
           <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">{tx("1LINK IBFT Rail")}</div>
           <div className="text-2xl font-bold text-emerald-600 flex items-center gap-2">
             <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></div>
             {tx("Active")}
           </div>
           <div className="text-xs text-slate-400 mt-2">{tx("API Latency: 42ms")}</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 flex flex-col justify-between">
           <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">{tx("Raast Bulk Directory")}</div>
           <div className="text-2xl font-bold text-emerald-600 flex items-center gap-2">
             <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></div>
             {tx("Active")}
           </div>
           <div className="text-xs text-slate-400 mt-2">{tx("API Latency: 85ms")}</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 flex flex-col justify-between">
           <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">{tx("Pre-Routing Validation")}</div>
           <div className="text-xs text-slate-600 space-y-1">
             <div className="flex justify-between"><span>{tx("IBAN Regex Checks:")}</span><span className="font-bold text-slate-800">{tx("Enforced")}</span></div>
             <div className="flex justify-between"><span>{tx("CNIC Title Match:")}</span><span className="font-bold text-slate-800">{tx("1LINK Enabled")}</span></div>
           </div>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
          <h2 className="text-sm font-bold text-slate-800">{tx("Dispatch Queue & H2H Files")}</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-100 text-xs">
              <tr>
                <th className="px-5 py-3 font-semibold">{tx("Batch / Run ID")}</th>
                <th className="px-5 py-3 font-semibold">{tx("Rail Type")}</th>
                <th className="px-5 py-3 font-semibold text-right">{tx("Records")}</th>
                <th className="px-5 py-3 font-semibold text-right">{tx("Net Disbursed")}</th>
                <th className="px-5 py-3 font-semibold">{tx("Status")}</th>
                <th className="px-5 py-3 font-semibold">{tx("Payload Checksum / Path")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-slate-400 text-xs">{tx("Loading dispatch queue...")}</td></tr>
              ) : batches.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-slate-400 text-xs">{tx("No payout batches found.")}</td></tr>
              ) : (
                pagedBatches.map((b) => (
                  <tr key={b.batchId} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-5 py-3">
                      <div className="font-medium text-slate-900">{b.batchId}</div>
                      <div className="text-[10px] text-slate-400 font-mono">{b.payoutRunId}</div>
                    </td>
                    <td className="px-5 py-3 text-xs font-medium text-slate-600">{b.railType}</td>
                    <td className="px-5 py-3 text-right font-medium text-slate-900">{b.totalRecords}</td>
                    <td className="px-5 py-3 text-right">
                      <div className="font-bold text-slate-900">{tx("Rs.")}{" "}{b.totalNetDisbursed.toLocaleString()}</div>
                      <div className="text-[10px] text-slate-400">{tx("Gross:")}{" "}{b.totalGrossAmount.toLocaleString()}</div>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        b.status === 'GENERATED' ? 'bg-amber-100 text-amber-800' :
                        b.status === 'QUEUED' ? 'bg-slate-100 text-slate-800' :
                        b.status === 'ACKNOWLEDGED' ? 'bg-emerald-100 text-emerald-800' :
                        b.status === 'FAILED' ? 'bg-rose-100 text-rose-800' :
                        'bg-blue-100 text-blue-800'
                      }`}>
                        {b.status}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="text-xs font-mono text-slate-600 max-w-[200px] truncate" title={b.fileChecksumSha256 ?? undefined}>
                        {b.fileChecksumSha256 ?? <span className="text-slate-400 italic">{tx("No file generated")}</span>}
                      </div>
                      <div className="text-[10px] text-slate-400">{b.filePath}</div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
          <Pagination pagination={pagination} noun={tx("payment batches")} inline />
      </div>
    </div>
  );
}
