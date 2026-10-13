// The portal's languages. The choice lives in its own cookie (cp_locale); the staff app's cookie is deliberately not shared.
export const LOCALES = ["en", "ur"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "cp_locale";
export const LOCALE_LABELS: Record<Locale, string> = { en: "English", ur: "اردو" };

export function isLocale(value: string | null | undefined): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}
export function localeDir(locale: Locale): "ltr" | "rtl" {
  return locale === "ur" ? "rtl" : "ltr";
}
