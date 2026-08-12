"use client";

import React from "react";
import Link from "next/link";
import { SECP_DEFAULT_RULES } from "../../services/commissions";

export default function RateCardPage() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Commission Types</h1>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/commissions"
            className="px-3.5 py-2 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-xl text-xs font-bold transition-all"
          >
            ← Back to Commissions
          </Link>
        </div>
      </div>

      <div className="bg-white p-6 rounded-2xl border border-slate-200 space-y-4 shadow-sm">
        <div>
          <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
            Commission Rates
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Current commission rates by policy type and year.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-2">
          {SECP_DEFAULT_RULES.map((rule) => (
            <div key={rule.id} className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <div className="flex justify-between items-start">
                <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-bold text-[10px] uppercase">
                  {rule.segment}
                </span>
                <span className="font-mono text-lg font-black text-blue-900">{rule.ratePct}%</span>
              </div>
              <h3 className="font-bold text-slate-800 text-xs">{rule.description}</h3>
              <p className="text-[10px] text-slate-500 font-mono">
                {rule.premiumType.replace("_", " ")} · Year {rule.policyYear}
              </p>
              <div className="pt-2 border-t border-slate-200/80 flex items-center justify-between text-[9px] text-slate-400">
                <span>Reference:</span>
                <span className="font-bold text-blue-700">{rule.secpRef}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
