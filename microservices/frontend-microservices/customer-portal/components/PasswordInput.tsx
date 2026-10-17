"use client";
import { useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";

export function PasswordInput({ id, value, onChange, autoComplete, placeholder, required = true }: {
  id: string; value: string; onChange: (v: string) => void; autoComplete: string; placeholder?: string; required?: boolean;
}) {
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input id={id} name={id} type={show ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} className="input pe-16" dir="ltr"
        autoComplete={autoComplete} placeholder={placeholder} required={required} maxLength={128} />
      <button type="button" onClick={() => setShow((s) => !s)} aria-pressed={show}
        className="absolute inset-y-0 end-0 px-3 text-xs font-semibold text-slate-500 hover:text-slate-800">{show ? t("password.hide") : t("password.show")}</button>
    </div>
  );
}
