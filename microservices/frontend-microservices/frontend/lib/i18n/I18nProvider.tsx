"use client";

import { createContext, useCallback, useContext, useMemo } from "react";
import { LOCALE_COOKIE, Locale, localeDir } from "./config";
import { setCurrentLocale, setUrduText, t, tx, type Vars } from "./tx";

const ONE_YEAR_S = 365 * 24 * 60 * 60;

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

export function I18nProvider({
  initialLocale,
  urduText,
  cookieDomain,
  children,
}: {
  initialLocale: Locale;
  /** The Urdu page text, passed by the root layout only when the language is Urdu (see loadPageText). */
  urduText?: Record<string, string>;
  /** Shared parent domain (SSO_COOKIE_DOMAIN) so the Automation Chat app sees the same choice; unset on localhost. */
  cookieDomain?: string;
  children: React.ReactNode;
}) {
  // Set while rendering, before any page below renders, so the plain `tx()` / `t()` functions see it too.
  setCurrentLocale(initialLocale);
  if (urduText) setUrduText(urduText);

  const setLocale = useCallback((next: Locale) => {
    if (next === initialLocale) return;
    document.cookie =
      `${LOCALE_COOKIE}=${next}; path=/; max-age=${ONE_YEAR_S}; samesite=lax` + (cookieDomain ? `; domain=${cookieDomain}` : "");
    // Reload rather than re-render: every page, toast and cached label is drawn again in the new language, and the
    // server sends the page with the right direction (lang/dir) from the first paint.
    window.location.reload();
  }, [cookieDomain, initialLocale]);

  const value = useMemo(
    () => ({ locale: initialLocale, dir: localeDir(initialLocale), setLocale, t, tx }),
    [initialLocale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside <I18nProvider>");
  return value;
}
