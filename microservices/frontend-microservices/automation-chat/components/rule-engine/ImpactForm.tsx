"use client";

import { ActuarialImpactDetail, ImpactType } from "@/app/services/ruleEngine";
import { IMPACT_TYPE_CONFIG, MEDICAL_PROFILE_OPTIONS, EXCLUSION_RIDER_OPTIONS } from "./constants";
import MultiTagSelector from "./MultiTagSelector";

interface Props {
  impactType: ImpactType;
  impactData: ActuarialImpactDetail;
  onChange: (impactType: ImpactType, impactData: ActuarialImpactDetail) => void;
}

const ALL_NUMBER_FIELDS: { key: keyof ActuarialImpactDetail; label: string; step?: string; icon: string; forTypes?: ImpactType[] }[] = [
  {
    key: "extra_mortality_pct",
    label: "Extra Mortality (%)",
    step: "0.1",
    icon: "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6",
    forTypes: ["APPLY_LOADING", "REFER_TO_UNDERWRITER"],
  },
  {
    key: "flat_extra_per_thousand",
    label: "Flat Extra (PKR / 1k TSAR)",
    step: "0.1",
    icon: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
    forTypes: ["APPLY_LOADING"],
  },
  {
    key: "hlv_max_multiple",
    label: "HLV Max Multiple (×)",
    step: "0.5",
    icon: "M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z",
    forTypes: ["REFER_TO_UNDERWRITER", "AUTO_APPROVE", "FINANCIAL_JUSTIFICATION"],
  },
  {
    key: "reinsurance_retention_limit",
    label: "Reinsurance Limit (PKR)",
    step: "1000",
    icon: "M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4",
    forTypes: ["REFER_TO_UNDERWRITER", "REINSURANCE_FACULTATIVE"],
  },
  {
    key: "underwriter_authority_level",
    label: "Authority Level",
    step: "1",
    icon: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z",
    forTypes: ["REFER_TO_UNDERWRITER"],
  },
  {
    key: "commission_pct",
    label: "Commission Rate (%)",
    step: "0.1",
    icon: "M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z",
    forTypes: ["AUTO_APPROVE", "REFER_TO_UNDERWRITER"],
  },
  {
    key: "withholding_tax_pct",
    label: "Withholding Tax (%)",
    step: "0.1",
    icon: "M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z",
    forTypes: ["AUTO_APPROVE", "REFER_TO_UNDERWRITER"],
  },
];

const IMPACT_TYPES = Object.keys(IMPACT_TYPE_CONFIG) as ImpactType[];

export default function ImpactForm({ impactType, impactData, onChange }: Props) {
  const setField = (key: keyof ActuarialImpactDetail, value: any) => {
    onChange(impactType, { ...impactData, [key]: value });
  };

  const handleTypeSelect = (type: ImpactType) => {
    const isTerminal = type === "DECLINE" || type === "AUTO_APPROVE";
    onChange(type, { ...impactData, is_terminal: isTerminal });
  };

  const relevantFields = ALL_NUMBER_FIELDS.filter(
    (f) => !f.forTypes || f.forTypes.includes(impactType)
  );

  return (
    <div className="space-y-4">
      {/* Dense Impact Type Selector — Compact Grid */}
      <div>
        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
          Underwriting Impact
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {IMPACT_TYPES.map((type) => {
            const cfg = IMPACT_TYPE_CONFIG[type];
            if (!cfg) return null;
            const isSelected = impactType === type;
            return (
              <button
                key={type}
                type="button"
                onClick={() => handleTypeSelect(type)}
                className={`flex items-center gap-2 p-2.5 rounded-xl border text-left transition cursor-pointer ${
                  isSelected
                    ? `${cfg.cardColor} ring-1 ring-blue-500 font-bold shadow-sm`
                    : "bg-white border-slate-200 text-slate-700 hover:border-slate-300 hover:bg-slate-50 font-medium"
                }`}
              >
                <svg className={`w-4 h-4 shrink-0 ${isSelected ? "text-blue-700" : "text-slate-400"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={cfg.iconPath} />
                </svg>
                <span className="text-xs truncate">{cfg.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Terminal Check & Outcome Row */}
      <div className="flex items-center justify-between gap-4 p-2.5 bg-slate-50 border border-slate-200 rounded-xl">
        <label className="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={!!impactData.is_terminal}
            onChange={(e) => setField("is_terminal", e.target.checked)}
            className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500"
          />
          Terminal Rule (Stop evaluation on match)
        </label>
      </div>

      {/* Relevant Parameters */}
      {relevantFields.length > 0 && (
        <div className="grid grid-cols-2 gap-2.5">
          {relevantFields.map(({ key, label, step, icon }) => (
            <div key={key} className="p-2.5 bg-white border border-slate-200 rounded-xl flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 truncate">
                <svg className="w-3.5 h-3.5 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={icon} />
                </svg>
                <span className="truncate">{label}</span>
              </label>
              <input
                type="number"
                step={step}
                min={0}
                value={impactData[key] !== null && impactData[key] !== undefined ? String(impactData[key]) : ""}
                onChange={(e) => setField(key, e.target.value === "" ? null : parseFloat(e.target.value))}
                className="w-24 border border-slate-200 rounded-lg px-2 py-1 text-xs font-bold text-slate-900 text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          ))}
        </div>
      )}

      {/* Medical Test Codes */}
      {(impactType === "REQUIRE_MEDICAL" || impactType === "REFER_TO_UNDERWRITER") && (
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1.5">Medical Test Codes</label>
          <MultiTagSelector
            selected={impactData.medical_profile_codes || []}
            onChange={(items) => setField("medical_profile_codes", items)}
            options={MEDICAL_PROFILE_OPTIONS}
            placeholder="Select medical tests (e.g. MER, FBS, ECG)..."
          />
        </div>
      )}

      {/* Exclusion Riders */}
      {(impactType === "EXCLUSION_CLAUSE" || impactType === "APPLY_LOADING") && (
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1.5">Exclusion Riders</label>
          <MultiTagSelector
            selected={impactData.exclusion_riders || []}
            onChange={(items) => setField("exclusion_riders", items)}
            options={EXCLUSION_RIDER_OPTIONS}
            placeholder="Select exclusion clauses (e.g. Aviation Exclusion)..."
          />
        </div>
      )}
    </div>
  );
}
