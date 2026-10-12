// The app's languages. The choice lives in the same cookie as the portal's (frontend/lib/i18n/config.ts), so both
// apps open in the same language; it is also sent to the chat agent, which replies in it.
export const LOCALES = ["en", "ur"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "insurance_locale";

/** Name of each language in that language, for the switcher. */
export const LOCALE_LABELS: Record<Locale, string> = { en: "English", ur: "اردو" };

export function isLocale(value: string | null | undefined): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

export function localeDir(locale: Locale): "ltr" | "rtl" {
  return locale === "ur" ? "rtl" : "ltr";
}
