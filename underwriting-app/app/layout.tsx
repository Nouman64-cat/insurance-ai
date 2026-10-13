import type { Metadata } from "next";
import { cookies } from "next/headers";
import { NotificationProvider } from "@/components/NotificationContext";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, localeDir } from "@/lib/i18n/config";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { loadPageText } from "@/lib/i18n/pageText";
import Protected from "@/components/workbench/Protected";
// The portal's stylesheet (Tailwind layers, RTL and Urdu font rules, the record-highlight animation), shared so both
// apps look the same. Resolved from ../frontend/app/globals.css: this app has no globals.css of its own.
import "@/app/globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "insurance-ai | Underwriting Workbench", template: "%s | Underwriting Workbench" },
  description: "Underwriting queue, case workspace, evidence review and risk evaluation.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The language cookie is shared with the portal (cookies are not port-specific; SSO_COOKIE_DOMAIN spans
  // subdomains), so the workbench opens in the language picked there, right-to-left for Urdu from the first paint.
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
