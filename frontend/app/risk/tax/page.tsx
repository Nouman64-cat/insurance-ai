"use client";
import React, { useState, useEffect, useCallback } from "react";
import { PayeeTaxProfile, listTaxProfiles } from "../../services/commissions";

export default function TaxRegimesPage() {
  const [profiles, setProfiles] = useState<PayeeTaxProfile[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listTaxProfiles();
      setProfiles(data);
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
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">FBR Tax Regimes</h1>
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">Risk & Regulatory</span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Manage Filer/Non-Filer withholding tax brackets and FBR reporting.
          </p>
        </div>
        <div className="flex items-center gap-2">
           <button className="text-xs font-semibold px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 shadow-sm transition-colors">
             Sync FBR ATL Database
           </button>
           <button className="text-xs font-semibold px-4 py-2 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 shadow-sm transition-colors text-slate-700">
             Generate Section 233 Challans
           </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
          <h2 className="text-sm font-bold text-slate-800">Payee Tax Profiles (Section 233)</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-100 text-xs">
              <tr>
                <th className="px-5 py-3 font-semibold">Payee ID</th>
                <th className="px-5 py-3 font-semibold">CNIC / NTN</th>
                <th className="px-5 py-3 font-semibold">FBR Status</th>
                <th className="px-5 py-3 font-semibold text-right">Applicable WHT</th>
                <th className="px-5 py-3 font-semibold text-right">Total WHT YTD</th>
                <th className="px-5 py-3 font-semibold">Last ATL Sync</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-slate-400 text-xs">Loading tax profiles...</td></tr>
              ) : profiles.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-slate-400 text-xs">No tax profiles found.</td></tr>
              ) : (
                profiles.map((p) => (
                  <tr key={p.payeeId} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-5 py-3 font-medium text-slate-900">{p.payeeId}</td>
                    <td className="px-5 py-3 font-mono text-xs text-slate-600">{p.cnicOrNtn}</td>
                    <td className="px-5 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        p.fbrStatus === 'ACTIVE_FILER' ? 'bg-emerald-100 text-emerald-800' :
                        p.fbrStatus === 'NON_FILER' ? 'bg-rose-100 text-rose-800' :
                        'bg-slate-100 text-slate-800'
                      }`}>
                        {p.fbrStatus.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className={`font-bold ${p.applicableWhtRate >= 0.20 ? 'text-rose-600' : 'text-slate-900'}`}>
                        {(p.applicableWhtRate * 100).toFixed(0)}%
                      </div>
                      {p.applicableWhtRate >= 0.20 && <div className="text-[10px] text-rose-500">Penalty Rate Applied</div>}
                    </td>
                    <td className="px-5 py-3 text-right font-medium text-slate-700">
                      Rs. {p.totalTaxWithheldYtd.toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-500">
                      {new Date(p.lastAtlSyncTimestamp).toLocaleString()}
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
