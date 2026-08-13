"use client";

import React from "react";
import Link from "next/link";
import { SECP_DEFAULT_RULES, CommissionRule } from "../../services/commissions";

export default function RateCardPage() {
  const getEventTags = (rule: CommissionRule) => {
    // Mapping events based on insurance domain logic and user request (LG, PC, PLI, PRC)
    if (rule.premiumType === "FIRST_YEAR") {
      if (rule.segment === "group") {
        return [
          { code: "LG", label: "LEAD GENERATION", color: "bg-indigo-50 text-indigo-700 border-indigo-200" },
          { code: "PLI", label: "POLICY ISSUANCE", color: "bg-purple-50 text-purple-700 border-purple-200" }
        ];
      }
      return [
        { code: "PLI", label: "POLICY ISSUANCE", color: "bg-purple-50 text-purple-700 border-purple-200" },
        { code: "PC", label: "PREMIUM COLLECTION", color: "bg-emerald-50 text-emerald-700 border-emerald-200" }
      ];
    }
    if (rule.premiumType === "RENEWAL") {
      return [
        { code: "PRC", label: "PREMIUM RECURRED COLLECTION", color: "bg-blue-50 text-blue-700 border-blue-200" }
      ];
    }
    if (rule.premiumType === "SINGLE_PREMIUM") {
      return [
        { code: "PC", label: "PREMIUM COLLECTION", color: "bg-emerald-50 text-emerald-700 border-emerald-200" }
      ];
    }
    return [];
  };

  const getTypeInfo = (premiumType: string) => {
    if (premiumType === "FIRST_YEAR" || premiumType === "SINGLE_PREMIUM") {
      return { label: "One-Time", className: "bg-slate-100 text-slate-700 border-slate-200" };
    }
    return { label: "Recurring", className: "bg-amber-50 text-amber-700 border-amber-200" };
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 md:p-8 space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 max-w-7xl mx-auto">
        <div>
          <h1 className="text-3xl font-black tracking-tight text-slate-900">Commission Types</h1>
          <p className="text-sm text-slate-500 mt-1 font-medium">
            Statutory commission matrix and payable events
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/commissions"
            className="px-4 py-2.5 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 hover:text-slate-900 rounded-xl text-sm font-bold transition-all shadow-sm flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back to Commissions
          </Link>
        </div>
      </div>

      <div className="max-w-7xl mx-auto">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50/80 border-b border-slate-200">
                  <th className="py-4 px-6 text-xs font-black text-slate-500 uppercase tracking-wider w-16 text-center">Sr. No</th>
                  <th className="py-4 px-6 text-xs font-black text-slate-500 uppercase tracking-wider">Commission Name & Ref</th>
                  <th className="py-4 px-6 text-xs font-black text-slate-500 uppercase tracking-wider">Event(s)</th>
                  <th className="py-4 px-6 text-xs font-black text-slate-500 uppercase tracking-wider w-32 text-center">Type</th>
                  <th className="py-4 px-6 text-xs font-black text-slate-500 uppercase tracking-wider w-24 text-right">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {SECP_DEFAULT_RULES.map((rule, index) => {
                  const typeInfo = getTypeInfo(rule.premiumType);
                  const events = getEventTags(rule);
                  
                  return (
                    <tr key={rule.id} className="hover:bg-slate-50/60 transition-colors group">
                      <td className="py-5 px-6 text-sm font-bold text-slate-400 text-center group-hover:text-slate-600 transition-colors">
                        {String(index + 1).padStart(2, '0')}
                      </td>
                      <td className="py-5 px-6">
                        <div className="flex flex-col gap-1.5">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-900 text-sm">
                              {rule.description}
                            </span>
                            <span className="px-2 py-0.5 rounded-md bg-blue-50 border border-blue-100 text-blue-700 font-bold text-[10px] uppercase tracking-wide">
                              {rule.segment}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-[11px] font-mono text-slate-500">
                            <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            {rule.secpRef}
                          </div>
                        </div>
                      </td>
                      <td className="py-5 px-6">
                        <div className="flex flex-wrap gap-2">
                          {events.map((evt) => (
                            <div
                              key={evt.code}
                              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[10px] font-bold tracking-wide ${evt.color}`}
                              title={evt.label}
                            >
                              <span>{evt.code}</span>
                              <span className="opacity-40">|</span>
                              <span className="opacity-80">{evt.label}</span>
                            </div>
                          ))}
                        </div>
                      </td>
                      <td className="py-5 px-6 text-center">
                        <span className={`inline-flex px-2.5 py-1 rounded-lg border text-xs font-bold ${typeInfo.className}`}>
                          {typeInfo.label}
                        </span>
                      </td>
                      <td className="py-5 px-6 text-right">
                        <span className="font-mono text-lg font-black text-slate-900 bg-slate-100 px-2.5 py-1 rounded-lg">
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
