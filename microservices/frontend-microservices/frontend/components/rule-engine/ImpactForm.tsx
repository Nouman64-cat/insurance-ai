"use client";

import { ActuarialImpactDetail, ImpactType } from "@/app/services/ruleEngine";
import { IMPACT_TYPE_CONFIG, MEDICAL_PROFILE_OPTIONS, EXCLUSION_RIDER_OPTIONS, RISK_FACTOR_OPTIONS } from "./constants";
import MultiTagSelector from "./MultiTagSelector";
import { tx } from "@/lib/i18n/tx";

interface Props {
  impactType: ImpactType;
  impactData: ActuarialImpactDetail;
  onChange: (impactType: ImpactType, impactData: ActuarialImpactDetail) => void;
}

const ALL_NUMBER_FIELDS: { key: keyof ActuarialImpactDetail; label: string; step?: string; icon: string; forTypes?: ImpactType[] }[] = [
  {
    key: "extra_mortality_pct",
    label: "Premium loading (%)",
    step: "0.1",
    icon: "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6",
    forTypes: ["APPLY_LOADING", "REFER_TO_UNDERWRITER"],
  },
  {
    key: "flat_extra_per_thousand",
    label: "Flat extra (PKR per 1,000 cover)",
    step: "0.1",
    icon: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
    forTypes: ["APPLY_LOADING"],
  },
  {
    key: "hlv_max_multiple",
    label: "Max cover (× income)",
    step: "0.5",
    icon: "M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z",
    forTypes: ["REFER_TO_UNDERWRITER", "AUTO_APPROVE", "FINANCIAL_JUSTIFICATION"],
  },
  {
    key: "reinsurance_retention_limit",
    label: "Reinsurer limit (PKR)",
    step: "1000",
    icon: "M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4",
    forTypes: ["REFER_TO_UNDERWRITER", "REINSURANCE_FACULTATIVE"],
  },
  {
    key: "underwriter_authority_level",
    label: "Approver level",
    step: "1",
    icon: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z",
    forTypes: ["REFER_TO_UNDERWRITER"],
  },
  {
    key: "commission_pct",
    label: "Commission rate (%)",
    step: "0.1",
    icon: "M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z",
    forTypes: ["AUTO_APPROVE", "REFER_TO_UNDERWRITER"],
  },
  {
    key: "upfront_payment_pct",
    label: "Upfront payment (%) — the rest is paid at issuance",
    step: "1",
    icon: "M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z",
    forTypes: ["AUTO_APPROVE"],
  },
  {
    key: "withholding_tax_pct",
    label: "Withholding tax (%)",
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
    // A decline ends the evaluation; other outcomes keep whatever the author chose in Advanced settings.
    onChange(type, type === "DECLINE" ? { ...impactData, is_terminal: true } : impactData);
  };

  const relevantFields = ALL_NUMBER_FIELDS.filter(
    (f) => !f.forTypes || f.forTypes.includes(impactType)
  );

  return (
    <div className="space-y-4">
      {/* Dense Impact Type Selector — Compact Grid */}
      <div>
        <label className="block text-xs font-medium text-slate-700 mb-2">
          {tx("Decision")}
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
                title={tx(cfg.description)}
                className={`flex items-center gap-2 p-2.5 rounded-xl border text-left transition cursor-pointer ${
                  isSelected
                    ? `${cfg.cardColor} ring-2 ring-blue-200 font-semibold`
                    : "bg-white border-slate-200 text-slate-700 hover:border-slate-300 hover:bg-slate-50 font-medium"
                }`}
              >
                <svg className={`w-4 h-4 shrink-0 ${isSelected ? "text-blue-700" : "text-slate-400"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={cfg.iconPath} />
                </svg>
                <span className="text-xs truncate">{tx(cfg.label)}</span>
              </button>
            );
          })}
        </div>
        {IMPACT_TYPE_CONFIG[impactType] && (
          <p className="mt-2 text-[11px] text-slate-500">{tx(IMPACT_TYPE_CONFIG[impactType].description)}</p>
        )}
      </div>

      {/* Relevant Parameters */}
      {relevantFields.length > 0 && (
        <div className="grid grid-cols-2 gap-2.5">
          {relevantFields.map(({ key, label, step, icon }) => (
            <div key={key} className="p-2.5 bg-slate-50/60 border border-slate-200 rounded-xl flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 truncate">
                <svg className="w-3.5 h-3.5 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={icon} />
                </svg>
                <span className="truncate">{tx(label)}</span>
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
          <label className="block text-xs font-medium text-slate-700 mb-1.5">{tx("Medical tests required")}</label>
          <MultiTagSelector
            selected={impactData.medical_profile_codes || []}
            onChange={(items) => setField("medical_profile_codes", items)}
            options={MEDICAL_PROFILE_OPTIONS}
            placeholder={tx("Select medical tests (e.g. MER, FBS, ECG)...")}
          />
        </div>
      )}

      {/* Reason + Lead Risk Assessment scoring */}
      <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3.5 space-y-3">
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">{tx("Why does this matter?")}</label>
          <textarea
            rows={2}
            value={impactData.reason ?? ""}
            onChange={(e) => setField("reason", e.target.value || null)}
            placeholder={tx("e.g. Excess weight raises the risk of diabetes, hypertension and heart disease.")}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
          />
          <p className="mt-0.5 text-[11px] text-slate-500">{tx("Shown to staff wherever this rule fires, e.g. under a risk in the Lead Risk Assessment.")}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">{tx("Counts towards (Lead Risk Assessment)")}</label>
            <select
              value={impactData.risk_factor ?? ""}
              onChange={(e) => setField("risk_factor", e.target.value || null)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
            >
              <option value="">{tx("Nothing — not a risk-assessment rule")}</option>
              {Array.from(new Set(RISK_FACTOR_OPTIONS.map((o) => o.section))).map((section) => (
                <optgroup key={section} label={tx(section)}>
                  {RISK_FACTOR_OPTIONS.filter((o) => o.section === section).map((o) => (
                    <option key={o.code} value={o.code}>{tx(o.label)}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          {impactData.risk_factor && (
            <div>
              <label className="flex justify-between text-xs font-bold text-slate-700 mb-1">
                <span>{tx("How risky is a match?")}</span>
                <span className="tabular-nums text-rose-700">{Math.round((impactData.risk_level ?? 0) * 100)}%</span>
              </label>
              <input
                type="range" min={0} max={1} step={0.05}
                value={impactData.risk_level ?? 0}
                onChange={(e) => setField("risk_level", parseFloat(e.target.value))}
                className="w-full accent-rose-400"
              />
              <p className="text-[11px] text-slate-500">{tx("How much of this factor's weight counts as risk when the rule matches (100% = fully adverse).")}</p>
            </div>
          )}
        </div>
      </div>

      {/* Exclusion Riders */}
      {(impactType === "EXCLUSION_CLAUSE" || impactType === "APPLY_LOADING") && (
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1.5">{tx("Exclusions to attach")}</label>
          <MultiTagSelector
            selected={impactData.exclusion_riders || []}
            onChange={(items) => setField("exclusion_riders", items)}
            options={EXCLUSION_RIDER_OPTIONS}
            placeholder={tx("Select exclusion clauses (e.g. Aviation Exclusion)...")}
          />
        </div>
      )}
    </div>
  );
}
