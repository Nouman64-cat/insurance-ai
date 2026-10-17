"use client";

import { createContext, useCallback, useContext, useMemo } from "react";
import { LOCALE_COOKIE, Locale, localeDir } from "./config";

export type Vars = Record<string, string | number | null | undefined>;
type Dict = Record<string, string>;

interface I18nValue {
  locale: Locale;
  dir: "ltr" | "rtl";
  t: (key: string, vars?: Vars) => string;
  setLocale: (locale: Locale) => void;
}

const Ctx = createContext<I18nValue | null>(null);

// In right-to-left text each inserted value (a policy number, a date, an English name) is wrapped in a bidi isolate, so it
// keeps its own order and punctuation instead of being re-ordered by the surrounding Urdu sentence.
function fill(text: string, vars?: Vars, isolate = false): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name) => {
    if (!(name in vars) || vars[name] == null) return m;
    const v = String(vars[name]);
    return isolate && v ? `\u2068${v}\u2069` : v;
  });
}

export function I18nProvider({ locale, messages, fallback, children }: { locale: Locale; messages: Dict; fallback: Dict; children: React.ReactNode }) {
  const t = useCallback((key: string, vars?: Vars) => fill(messages[key] ?? fallback[key] ?? key, vars, locale === "ur"), [messages, fallback, locale]);
  const setLocale = useCallback((next: Locale) => {
    if (next === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${365 * 24 * 3600}; samesite=lax`;
    window.location.reload();   // server components and every cached label are drawn again in the new language
  }, [locale]);
  const value = useMemo(() => ({ locale, dir: localeDir(locale), t, setLocale }), [locale, t, setLocale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useI18n must be used inside <I18nProvider>");
  return v;
}
