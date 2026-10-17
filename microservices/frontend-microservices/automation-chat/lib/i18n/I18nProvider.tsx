"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { LOCALE_COOKIE, Locale, localeDir } from "./config";
import en from "./messages/en";
import ur from "./messages/ur";

const MESSAGES = { en, ur };
const ONE_YEAR_S = 365 * 24 * 60 * 60;

type Vars = Record<string, string | number>;

interface I18nValue {
  locale: Locale;
  dir: "ltr" | "rtl";
  setLocale: (locale: Locale) => void;
  /** Text for a dotted key ("sidebar.logout"), with {name} placeholders filled from `vars`. Falls back to English. */
  t: (key: string, vars?: Vars) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function lookup(messages: unknown, key: string): string | undefined {
  const value = key.split(".").reduce<any>((node, part) => (node == null ? undefined : node[part]), messages);
  return typeof value === "string" ? value : undefined;
}

export function I18nProvider({
  initialLocale,
  cookieDomain,
  children,
}: {
  initialLocale: Locale;
  /** Shared parent domain (SSO_COOKIE_DOMAIN) so the portal sees the same choice; unset on localhost. */
  cookieDomain?: string;
  children: React.ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    document.cookie =
      `${LOCALE_COOKIE}=${next}; path=/; max-age=${ONE_YEAR_S}; samesite=lax` + (cookieDomain ? `; domain=${cookieDomain}` : "");
    document.documentElement.lang = next;
    document.documentElement.dir = localeDir(next);
  }, [cookieDomain]);

  const dir = localeDir(locale);
  const t = useCallback((key: string, vars?: Vars) => {
    const text = lookup(MESSAGES[locale], key) ?? lookup(en, key) ?? key;
    // In right-to-left text each value is wrapped in a bidi isolate, so a value with its own direction (an English
    // chat title ending in "?") keeps its punctuation in place.
    const filled = vars
      ? text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? (dir === "rtl" ? `\u2068${vars[name]}\u2069` : String(vars[name])) : match))
      : text;
    // Each paragraph takes its direction from its first letter (globals.css), so an Urdu string that opens with a
    // Latin word ("LLM کنفیگریشن") would be laid out left-to-right: the invisible right-to-left mark prevents that.
    return dir === "rtl" ? `\u200F${filled}` : filled;
  }, [locale, dir]);

  const value = useMemo(() => ({ locale, dir, setLocale, t }), [locale, dir, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside <I18nProvider>");
  return value;
}
