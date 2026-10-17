"use client";
import { LOCALES, LOCALE_LABELS } from "@/lib/i18n/config";
import { useI18n } from "@/lib/i18n/I18nProvider";

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div role="group" aria-label={t("common.language")} className="flex items-center rounded-lg border border-slate-200 bg-white p-0.5">
      {LOCALES.map((code) => (
        <button key={code} type="button" lang={code} aria-pressed={code === locale} onClick={() => setLocale(code)}
          className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${code === locale ? "bg-blue-600 text-white" : "text-slate-500 hover:text-slate-900"}`}>
          {LOCALE_LABELS[code]}
        </button>
      ))}
    </div>
  );
}
