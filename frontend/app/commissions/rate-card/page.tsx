"use client";

import React from "react";
import Link from "next/link";
import { SECP_DEFAULT_RULES, CommissionRule } from "../../services/commissions";

export default function RateCardPage() {
  const getEventTags = (rule: CommissionRule) => {
    if (rule.premiumType === "FIRST_YEAR") {
      if (rule.segment === "group") {
        return [
          { code: "LG", label: "LEAD GENERATION" },
          { code: "PLI", label: "POLICY ISSUANCE" }
        ];
      }
      return [
        { code: "PLI", label: "POLICY ISSUANCE" },
        { code: "PC", label: "PREMIUM COLLECTION" }
      ];
    }
    if (rule.premiumType === "RENEWAL") {
      return [
        { code: "PRC", label: "PREMIUM RECURRED COLLECTION" }
      ];
    }
    if (rule.premiumType === "SINGLE_PREMIUM") {
      return [
        { code: "PC", label: "PREMIUM COLLECTION" }
      ];
    }
    return [];
  };

  const getTypeInfo = (premiumType: string) => {
    if (premiumType === "FIRST_YEAR" || premiumType === "SINGLE_PREMIUM") {
      return { label: "One-Time", className: "bg-slate-100 text-slate-700 border-slate-200 font-medium" };
    }
    return { label: "Recurring", className: "bg-blue-50 text-blue-700 border-blue-200 font-medium" };
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 p-6 md:p-8 space-y-6 font-sans">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 max-w-7xl mx-auto">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900">Commission Types</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Statutory commission matrix and payable events
          </p>
        </div>
        <Link
          href="/commissions"
          className="px-3.5 py-2 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-lg text-xs font-semibold transition shadow-xs flex items-center gap-2"
        >
          <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to Commissions
        </Link>
      </div>

      {/* Main Table */}
      <div className="max-w-7xl mx-auto">
        <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-700 whitespace-nowrap">
              <thead>
                <tr className="bg-slate-50 text-slate-500 uppercase text-[10px] tracking-wider border-b border-slate-200 font-semibold">
                  <th className="py-3.5 px-5 w-16 text-center">Sr. No</th>
                  <th className="py-3.5 px-5">Commission Name & Ref</th>
                  <th className="py-3.5 px-5">Event(s)</th>
                  <th className="py-3.5 px-5 text-center w-32">Type</th>
                  <th className="py-3.5 px-5 text-right w-28">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {SECP_DEFAULT_RULES.map((rule, index) => {
                  const typeInfo = getTypeInfo(rule.premiumType);
                  const events = getEventTags(rule);
                  
                  return (
                    <tr key={rule.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-4 px-5 text-slate-400 font-mono text-[11px] text-center font-semibold">
                        {String(index + 1).padStart(2, '0')}
                      </td>
                      <td className="py-4 px-5">
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-slate-900 text-xs">
                              {rule.description}
                            </span>
                            <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-600 border border-slate-200 uppercase">
                              {rule.segment}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 text-[11px] font-mono text-slate-400">
                            <svg className="w-3.5 h-3.5 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            {rule.secpRef}
                          </div>
                        </div>
                      </td>
                      <td className="py-4 px-5">
                        <div className="flex flex-wrap gap-1.5">
                          {events.map((evt) => (
                            <div
                              key={evt.code}
                              className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-50 text-slate-700 border border-slate-200 text-[10px] font-semibold"
                              title={evt.label}
                            >
                              <span className="text-blue-700 font-mono">{evt.code}</span>
                              <span className="text-slate-300">|</span>
                              <span className="text-slate-600 font-medium">{evt.label}</span>
                            </div>
                          ))}
                        </div>
                      </td>
                      <td className="py-4 px-5 text-center">
                        <span className={`inline-flex px-2.5 py-0.5 rounded text-[11px] border ${typeInfo.className}`}>
                          {typeInfo.label}
                        </span>
                      </td>
                      <td className="py-4 px-5 text-right">
                        <span className="font-mono text-sm font-bold text-slate-900 px-2 py-0.5 bg-slate-50 border border-slate-200 rounded">
                          {rule.ratePct}%
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
