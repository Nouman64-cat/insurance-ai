import type { Metadata } from "next";
import { cookies } from "next/headers";
import { NotificationProvider } from "@/components/NotificationContext";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, localeDir } from "@/lib/i18n/config";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { loadPageText } from "@/lib/i18n/pageText";
import Protected from "@/components/Protected";
// The portal's stylesheet, shared (resolved from ../frontend/app/globals.css).
import "@/app/globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "GetInsuredAI | Customer Service", template: "%s | Customer Service | GetInsuredAI" },
  description: "Submit, route, review and track requests.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const saved = cookies().get(LOCALE_COOKIE)?.value;
  const locale = isLocale(saved) ? saved : DEFAULT_LOCALE;
  const urduText = await loadPageText(locale);
  return (
    <html lang={locale} dir={localeDir(locale)} suppressHydrationWarning>
      <body className="bg-slate-50 font-sans">
        <I18nProvider initialLocale={locale} urduText={urduText} cookieDomain={process.env.SSO_COOKIE_DOMAIN || undefined}>
          <NotificationProvider>
            <Protected>{children}</Protected>
          </NotificationProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
