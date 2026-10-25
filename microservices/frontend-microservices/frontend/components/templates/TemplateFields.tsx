"use client";

import { tx } from "@/lib/i18n/tx";
import { isVisible, RENDERABLE, type Custom } from "@/lib/leadTemplate";
import type { Field } from "@/lib/templates";

const box = "w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400 focus:bg-white";

/** Draws fields of a template: one input per field, by type, with the required marker, help text and "show only if" rules.
 *  The values are kept by the caller (the form saves them with the customer). */
export default function TemplateFields({ fields, values, onChange, invalid = [] }: { fields: Field[]; values: Custom; onChange: (id: string, v: string | number | boolean) => void; invalid?: string[] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4" data-testid="template-fields">
      {fields.filter((f) => isVisible(f, values)).map((f) => {
        const v = values[f.id];
        const bad = invalid.includes(f.id);
        const label = (
          <label className="text-xs font-semibold text-slate-600" htmlFor={`tpl-${f.id}`}>
            {f.label}{f.required ? " *" : ""}
          </label>
        );
        const help = f.help ? <span className="block text-[10px] text-slate-400">{f.help}</span> : null;
        const err = bad ? <span className="block text-[10px] text-red-500">{tx("This field is required.")}</span> : null;
        const wide = f.type === "textarea" ? "md:col-span-3" : "";
        if (!(RENDERABLE as readonly string[]).includes(f.type)) {
          return <div key={f.id} className="md:col-span-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{f.label}: {tx("this kind of field cannot be shown on this form yet.")}</div>;
        }
        if (f.type === "checkbox") {
          return (
            <div key={f.id} className={wide}>
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                <input id={`tpl-${f.id}`} type="checkbox" checked={v === true} onChange={(e) => onChange(f.id, e.target.checked)} />{f.label}{f.required ? " *" : ""}
              </label>{help}{err}
            </div>
          );
        }
        if (f.type === "yes_no") {
          return (
            <div key={f.id} className={wide}>
              {label}
              <div className="flex gap-3 mt-1" role="radiogroup" aria-label={f.label}>
                {["Yes", "No"].map((o) => (
                  <label key={o} className="flex items-center gap-1 text-xs text-slate-600"><input type="radio" name={`tpl-${f.id}`} checked={(v === true && o === "Yes") || (v === false && o === "No")} onChange={() => onChange(f.id, o === "Yes")} />{tx(o)}</label>
                ))}
              </div>{help}{err}
            </div>
          );
        }
        if (f.type === "select") {
          return (
            <div key={f.id} className={wide}>
              {label}
              <select id={`tpl-${f.id}`} className={`${box} ${bad ? "border-red-400" : ""}`} value={String(v ?? "")} onChange={(e) => onChange(f.id, e.target.value)}>
                <option value="">{tx("Select…")}</option>
                {(f.options ?? []).map((o) => <option key={o.id} value={o.value ?? o.label}>{o.label}</option>)}
              </select>{help}{err}
            </div>
          );
        }
        if (f.type === "textarea") {
          return <div key={f.id} className={wide}>{label}<textarea id={`tpl-${f.id}`} rows={3} className={`${box} ${bad ? "border-red-400" : ""}`} maxLength={f.max_length} placeholder={f.placeholder} value={String(v ?? "")} onChange={(e) => onChange(f.id, e.target.value)} />{help}{err}</div>;
        }
        const type = f.type === "number" ? "number" : f.type === "date" ? "date" : f.type === "phone" ? "tel" : "text";
        return (
          <div key={f.id} className={wide}>
            {label}
            <input id={`tpl-${f.id}`} type={type} className={`${box} ${bad ? "border-red-400" : ""}`} maxLength={f.max_length} placeholder={f.placeholder}
              value={String(v ?? "")} onChange={(e) => onChange(f.id, type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)} />
            {help}{err}
          </div>
        );
      })}
    </div>
  );
}
