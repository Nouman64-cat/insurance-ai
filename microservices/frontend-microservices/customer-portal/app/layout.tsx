import type { Metadata } from "next";
import { cookies } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, localeDir } from "@/lib/i18n/config";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { en, ur } from "@/lib/i18n/messages";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "GetInsuredAI | Customer Portal", template: "%s | GetInsuredAI" },
  description: "View your policies, premiums, claims and documents.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const saved = cookies().get(LOCALE_COOKIE)?.value;
  const locale = isLocale(saved) ? saved : DEFAULT_LOCALE;
  return (
    <html lang={locale} dir={localeDir(locale)}>
      <body>
        <I18nProvider locale={locale} messages={locale === "ur" ? ur : en} fallback={en}>{children}</I18nProvider>
      </body>
    </html>
  );
}
