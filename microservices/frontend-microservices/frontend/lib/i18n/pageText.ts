import type { Locale } from "./config";

/**
 * The page text a root layout passes to I18nProvider: the Urdu dictionary when the language is Urdu, nothing for
 * English (pages are written in English). Server-side only: importing it here keeps the dictionary out of the
 * browser bundle for English users.
 */
export async function loadPageText(locale: Locale): Promise<Record<string, string> | undefined> {
  if (locale !== "ur") return undefined;
  return (await import("./messages/ur-text")).default;
}
