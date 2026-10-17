"use client";

import { LOCALES, LOCALE_LABELS } from "@/lib/i18n/config";
import { useI18n } from "@/lib/i18n/I18nProvider";

/** English / اردو toggle. `dark` styles it for the login page's dark background. */
export function LanguageSwitcher({ dark = false }: { dark?: boolean }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <div
      role="group"
      aria-label={t("common.language")}
      className={`flex items-center rounded-lg border p-0.5 ${dark ? "border-slate-700 bg-slate-900/60" : "border-slate-200 bg-white"}`}
    >
      {LOCALES.map((code) => {
        const active = code === locale;
        return (
          <button
            key={code}
            type="button"
            lang={code}
            aria-pressed={active}
            onClick={() => setLocale(code)}
            className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
              active
                ? "bg-blue-600 text-white"
                : dark ? "text-slate-400 hover:text-slate-200" : "text-slate-500 hover:text-slate-900"
            }`}
          >
            {LOCALE_LABELS[code]}
          </button>
        );
      })}
    </div>
  );
}
