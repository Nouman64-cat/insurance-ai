"use client";

import { Field as UiField } from "@/components/ui";
import { isVisible, RENDERABLE, type Custom, type Field } from "@/lib/leadTemplate";

/** The fields a Super Admin added to the lead form, drawn in the portal's own style. Answers are kept by the caller and sent with the application. */
export default function ExtraFields({ fields, values, onChange, invalid }: { fields: Field[]; values: Custom; onChange: (id: string, v: string | number | boolean) => void; invalid: string[] }) {
  return (
    <>
      {fields.filter((f) => isVisible(f, values)).map((f) => {
        const id = `x_${f.id}`;
        const v = values[f.id];
        const label = f.label + (f.required ? " *" : "");
        const err = invalid.includes(f.id) ? "required" : null;
        if (!(RENDERABLE as readonly string[]).includes(f.type)) return null;
        if (f.type === "checkbox") {
          return (
            <label key={f.id} className="flex items-center gap-2.5 text-sm text-slate-700">
              <input id={id} type="checkbox" checked={v === true} onChange={(e) => onChange(f.id, e.target.checked)} /><span>{label}</span>
            </label>
          );
        }
        if (f.type === "yes_no") {
          return (
            <div key={f.id}>
              <p className="text-sm text-slate-700 mb-1">{label}</p>
              <div className="flex gap-4" role="radiogroup" aria-label={f.label}>
                {["Yes", "No"].map((o) => <label key={o} className="flex items-center gap-1.5 text-sm text-slate-600"><input type="radio" name={id} checked={(v === true && o === "Yes") || (v === false && o === "No")} onChange={() => onChange(f.id, o === "Yes")} />{o}</label>)}
              </div>
            </div>
          );
        }
        return (
          <div key={f.id} className={f.type === "textarea" ? "sm:col-span-2" : ""}>
            <UiField label={label} htmlFor={id} error={err} hint={f.help}>
              {f.type === "select" ? (
                <select id={id} className="input" value={String(v ?? "")} onChange={(e) => onChange(f.id, e.target.value)}>
                  <option value="">—</option>
                  {(f.options ?? []).map((o) => <option key={o.id} value={o.value ?? o.label}>{o.label}</option>)}
                </select>
              ) : f.type === "textarea" ? (
                <textarea id={id} className="input min-h-[80px]" maxLength={f.max_length} placeholder={f.placeholder} value={String(v ?? "")} onChange={(e) => onChange(f.id, e.target.value)} />
              ) : (
                <input id={id} className="input" type={f.type === "number" ? "number" : f.type === "date" ? "date" : f.type === "phone" ? "tel" : "text"} maxLength={f.max_length}
                  placeholder={f.placeholder} value={String(v ?? "")} onChange={(e) => onChange(f.id, f.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)} />
              )}
            </UiField>
          </div>
        );
      })}
    </>
  );
}
