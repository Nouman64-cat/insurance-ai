"use client";

import { ActuarialImpactDetail, ImpactType } from "@/app/services/ruleEngine";
import { IMPACT_TYPE_LABELS } from "./constants";

interface Props {
  impactType: ImpactType;
  impactData: ActuarialImpactDetail;
  actionOutcome: string;
  onImpactTypeChange: (t: ImpactType) => void;
  onImpactDataChange: (d: ActuarialImpactDetail) => void;
  onActionOutcomeChange: (s: string) => void;
}

const NUMBER_FIELDS: { key: keyof ActuarialImpactDetail; label: string; step?: string }[] = [
  { key: "extra_mortality_pct", label: "Extra Mortality Loading (%)", step: "0.1" },
  { key: "flat_extra_per_thousand", label: "Flat Extra (PKR per 1,000 TSAR)", step: "0.1" },
  { key: "hlv_max_multiple", label: "HLV Max Multiple (× income)", step: "0.5" },
  { key: "reinsurance_retention_limit", label: "Reinsurance Retention Limit (PKR)", step: "1000" },
  { key: "underwriter_authority_level", label: "Underwriter Authority Level", step: "1" },
  { key: "commission_pct", label: "Commission Rate (%)", step: "0.1" },
  { key: "withholding_tax_pct", label: "Withholding Tax Rate (%)", step: "0.1" },
];

const LIST_FIELDS: { key: "medical_profile_codes" | "exclusion_riders"; label: string; placeholder: string }[] = [
  { key: "medical_profile_codes", label: "Medical Tests Required", placeholder: "e.g. MER, FBS, ECG" },
  { key: "exclusion_riders", label: "Exclusion Riders", placeholder: "e.g. Adventure Sports" },
];

/**
 * Structured ActuarialImpactDetail form — every field is an individual input,
 * never raw JSON. Used by the Add/Edit Rule modal.
 */
export default function ImpactForm({
  impactType, impactData, actionOutcome, onImpactTypeChange, onImpactDataChange, onActionOutcomeChange,
}: Props) {
  const setField = (key: keyof ActuarialImpactDetail, value: any) => {
    onImpactDataChange({ ...impactData, [key]: value });
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs text-slate-700 font-semibold mb-1">Underwriting Impact</label>
        <select
          value={impactType}
          onChange={(e) => onImpactTypeChange(e.target.value as ImpactType)}
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium"
        >
          {Object.entries(IMPACT_TYPE_LABELS).map(([value, { label }]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs text-slate-700 font-semibold mb-1">Outcome Label</label>
        <input
          value={actionOutcome}
          onChange={(e) => onActionOutcomeChange(e.target.value)}
          placeholder="e.g. REQUIRE_MEDICAL_EXAM"
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        {NUMBER_FIELDS.map(({ key, label, step }) => (
          <div key={key}>
            <label className="block text-[11px] text-slate-600 font-medium mb-1">{label}</label>
            <input
              type="number"
              step={step}
              value={(impactData[key] as number | null) ?? ""}
              onChange={(e) => setField(key, e.target.value === "" ? null : Number(e.target.value))}
              className="w-full border border-slate-200 rounded-md px-2.5 py-1.5 text-xs font-medium"
            />
          </div>
        ))}
      </div>

      {LIST_FIELDS.map(({ key, label, placeholder }) => (
        <div key={key}>
          <label className="block text-[11px] text-slate-600 font-medium mb-1">{label}</label>
          <input
            value={(impactData[key] as string[]).join(", ")}
            onChange={(e) => setField(key, e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
            placeholder={placeholder}
            className="w-full border border-slate-200 rounded-md px-2.5 py-1.5 text-xs font-medium"
          />
        </div>
      ))}

      <label className="flex items-center gap-2 p-2.5 bg-amber-50 border border-amber-200 rounded-lg cursor-pointer">
        <input
          type="checkbox"
          checked={impactData.is_terminal}
          onChange={(e) => setField("is_terminal", e.target.checked)}
          className="rounded border-slate-300"
        />
        <span className="text-xs font-semibold text-amber-800">
          Terminal — stop evaluating lower-priority rules once this one matches
        </span>
      </label>
    </div>
  );
}
