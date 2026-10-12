"use client";

import { useState, useEffect } from "react";
import CriteriaGroupBuilder from "./CriteriaGroupBuilder";
import ImpactForm from "./ImpactForm";
import { RuleCriteriaDraft, ActuarialImpactDetail, ImpactType } from "@/app/services/ruleEngine";

interface Props {
  mode: "add" | "edit";
  ruleSetCode: string;
  ruleCode?: string;
  initialRule?: any;
  onClose: () => void;
  onSave: (ruleData: {
    success: boolean;
    conditions: RuleCriteriaDraft[];
    impact: { type: ImpactType } & ActuarialImpactDetail;
    name?: string;
    priority?: number;
    rule_code?: string;
  }) => void;
}

export default function RuleBuilderModal({ mode, ruleSetCode, ruleCode, initialRule, onClose, onSave }: Props) {
  const [name, setName] = useState(initialRule?.name || "");
  const [code, setCode] = useState(initialRule?.rule_code || ruleCode || "");
  const [priority, setPriority] = useState<number>(initialRule?.priority || 100);
  
  const [criteria, setCriteria] = useState<RuleCriteriaDraft[]>(initialRule?.criteria || []);
  const [impactType, setImpactType] = useState<ImpactType>(
    (initialRule?.action_outcome as ImpactType) || "REQUIRE_MEDICAL_EXAM"
  );
  
  // Extract initial impact data, removing standard keys
  const getInitialImpactData = () => {
    if (!initialRule) return { is_terminal: false };
    const { action_outcome, criteria, name, rule_code, priority, is_active, ...rest } = initialRule;
    return { ...rest, is_terminal: !!initialRule.is_terminal };
  };
  
  const [impactData, setImpactData] = useState<ActuarialImpactDetail>(getInitialImpactData());

  const handleSave = () => {
    onSave({
      success: true,
      name: name || undefined,
      rule_code: code || undefined,
      priority,
      conditions: criteria,
      impact: {
        type: impactType,
        ...impactData
      }
    });
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />
      
      <div className="relative w-full max-w-4xl bg-white rounded-2xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">
                {mode === "add" ? "Add New Rule" : "Edit Rule"}
              </h2>
              <p className="text-xs font-medium text-slate-500">
                Rule Set: <span className="font-bold text-slate-700">{ruleSetCode}</span>
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          {/* Metadata */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">Rule Name *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. High Age + High Sum Assured"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-semibold text-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">Rule Code *</label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Auto-generated if empty"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-semibold text-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">Priority *</label>
              <input
                type="number"
                value={priority}
                onChange={(e) => setPriority(parseInt(e.target.value))}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-bold text-slate-900 text-center focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>

          <hr className="border-slate-200" />

          {/* Criteria */}
          <div>
            <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider mb-4 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-xs">1</span>
              Matching Criteria
            </h3>
            <CriteriaGroupBuilder
              criteria={criteria}
              onChange={setCriteria}
            />
          </div>

          <hr className="border-slate-200" />

          {/* Impact */}
          <div>
            <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider mb-4 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-xs">2</span>
              Underwriting Impact
            </h3>
            <ImpactForm
              impactType={impactType}
              impactData={impactData}
              onChange={(type, data) => {
                setImpactType(type);
                setImpactData(data);
              }}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 font-semibold text-slate-600 bg-white border border-slate-300 rounded-xl hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={criteria.length === 0}
            className="px-6 py-2 font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl shadow-sm hover:shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Save Rule
          </button>
        </div>
      </div>
    </div>
  );
}
