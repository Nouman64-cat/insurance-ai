"use client";
import React, { useState, useEffect, useCallback } from "react";
import { SecpRegulatoryMetric, listSecpMetrics } from "../../services/commissions";

export default function SECPExpenseCapPage() {
  const [metrics, setMetrics] = useState<SecpRegulatoryMetric[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listSecpMetrics();
      setMetrics(data);
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
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">SECP Expense Cap Monitor</h1>
            {/* <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">Risk & Regulatory</span> */}
          </div>
          {/* <p className="text-xs text-slate-500 mt-1">
              Ensure company-wide distribution expenses strictly comply with SECP statutory limits (Insurance Ordinance 2000).
            </p> */}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {loading ? (
          <div className="col-span-3 py-12 text-center text-slate-400 text-xs bg-white rounded-xl shadow-sm border border-slate-200">Loading statutory metrics...</div>
        ) : metrics.length === 0 ? (
          <div className="col-span-3 py-12 text-center text-slate-400 text-xs bg-white rounded-xl shadow-sm border border-slate-200">No data available.</div>
        ) : (
          metrics.map((m) => (
            <div key={m.productLine} className={`bg-white rounded-xl shadow-sm border p-6 flex flex-col justify-between ${m.complianceStatus === 'BREACHED' ? 'border-rose-300' :
              m.complianceStatus === 'WARNING_85_PERCENT' ? 'border-amber-300' :
                'border-slate-200'
              }`}>
              <div>
                <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4">{m.productLine.replace(/_/g, ' ')}</div>

                <div className="flex justify-between items-end mb-2">
                  <div>
                    <div className="text-3xl font-bold text-slate-900">{m.currentExpenseRatio.toFixed(2)}%</div>
                    <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wide">Current Expense Ratio</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-slate-400">{m.secpStatutoryCapRatio.toFixed(2)}%</div>
                    <div className="text-[10px] text-slate-400 uppercase tracking-wide">SECP Cap</div>
                  </div>
                </div>

                <div className="w-full bg-slate-100 rounded-full h-2.5 mb-6 overflow-hidden flex">
                  <div className={`h-2.5 ${m.complianceStatus === 'BREACHED' ? 'bg-rose-500' : m.complianceStatus === 'WARNING_85_PERCENT' ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min((m.currentExpenseRatio / m.secpStatutoryCapRatio) * 100, 100)}%` }}></div>
                </div>

                <div className="space-y-3">
                  <div className="flex justify-between text-xs border-b border-slate-100 pb-2">
                    <span className="text-slate-500">Gross Premium (FY)</span>
                    <span className="font-semibold text-slate-800">Rs. {(m.totalGrossPremiumCollected / 1000000).toFixed(2)}M</span>
                  </div>
                  <div className="flex justify-between text-xs border-b border-slate-100 pb-2">
                    <span className="text-slate-500">Distribution Expense</span>
                    <span className="font-semibold text-slate-800">Rs. {(m.totalDistributionExpense / 1000000).toFixed(2)}M</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">Variance to Cap</span>
                    <span className={`font-semibold ${m.variancePercentage < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                      {m.variancePercentage > 0 ? '+' : ''}{m.variancePercentage.toFixed(2)}%
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-6 pt-4 border-t border-slate-100 flex items-center justify-between">
                <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${m.complianceStatus === 'BREACHED' ? 'bg-rose-100 text-rose-800' :
                  m.complianceStatus === 'WARNING_85_PERCENT' ? 'bg-amber-100 text-amber-800' :
                    'bg-emerald-100 text-emerald-800'
                  }`}>
                  {m.complianceStatus.replace(/_/g, ' ')}
                </span>
                {m.complianceStatus !== 'COMPLIANT' && (
                  <button className="text-[10px] font-bold text-slate-500 hover:text-slate-800 underline">View Audit Guardrails</button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
