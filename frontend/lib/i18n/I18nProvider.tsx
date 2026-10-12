"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { LOCALE_COOKIE, Locale, localeDir } from "./config";
import en from "./messages/en";
import ur from "./messages/ur";
import urText from "./messages/ur-text";

const MESSAGES = { en, ur };
const ONE_YEAR_S = 365 * 24 * 60 * 60;

type Vars = Record<string, string | number>;

interface I18nValue {
  locale: Locale;
  dir: "ltr" | "rtl";
  setLocale: (locale: Locale) => void;
  /** Text for a dotted key ("sidebar.logout"), with {name} placeholders filled from `vars`. Falls back to English. */
  t: (key: string, vars?: Vars) => string;
  /**
   * Page text, looked up by its English wording ("Advanced Filters", "{count} plan(s) selected") in
   * messages/ur-text.ts, with {name} placeholders filled from `vars`. Wording with no translation yet stays English.
   */
  tx: (text: string, vars?: Vars) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function lookup(messages: unknown, key: string): string | undefined {
  const value = key.split(".").reduce<any>((node, part) => (node == null ? undefined : node[part]), messages);
  return typeof value === "string" ? value : undefined;
}

function fill(text: string, vars?: Vars): string {
  return vars ? text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match)) : text;
}

/** Each paragraph takes its direction from its first letter (globals.css), so an Urdu string that opens with a
 *  Latin word ("LLM کنفیگریشن") would be laid out left-to-right: a leading right-to-left mark prevents that. */
function marked(locale: Locale, text: string): string {
  return localeDir(locale) === "rtl" ? `\u200F${text}` : text;
}

export function I18nProvider({
  initialLocale,
  cookieDomain,
  children,
}: {
  initialLocale: Locale;
  /** Shared parent domain (SSO_COOKIE_DOMAIN) so the Automation Chat app sees the same choice; unset on localhost. */
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
  const t = useCallback((key: string, vars?: Vars) => (
    marked(locale, fill(lookup(MESSAGES[locale], key) ?? lookup(en, key) ?? key, vars))
  ), [locale]);

  const tx = useCallback((text: string, vars?: Vars) => {
    const translated = locale === "ur" ? urText[text] : undefined;
    // Wording with no translation yet is left exactly as it is (no direction mark), so it still reads as English.
    return translated === undefined ? fill(text, vars) : marked(locale, fill(translated, vars));
  }, [locale]);

  const value = useMemo(() => ({ locale, dir, setLocale, t, tx }), [locale, dir, setLocale, t, tx]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside <I18nProvider>");
  return value;
}
