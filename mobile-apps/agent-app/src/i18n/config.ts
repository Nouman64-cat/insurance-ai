// The app's languages, the same two as the web portal (frontend/lib/i18n/config.ts). The choice is kept on the
// device and sent with every chat turn, so the copilot replies in it.
export const LOCALES = ['en', 'ur'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_STORAGE_KEY = 'app_locale';

/** Name of each language in that language, for the picker. */
export const LOCALE_LABELS: Record<Locale, string> = { en: 'English', ur: 'اردو' };

export function isLocale(value: string | null | undefined): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}
