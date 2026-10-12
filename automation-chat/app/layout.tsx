import type { Metadata } from "next";
import { CopilotProvider } from "@/components/CopilotContext";
import { NotificationProvider } from "@/components/NotificationContext";
import SsoGate from "@/components/sso/SsoGate";
import { cookies } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, localeDir } from "@/lib/i18n/config";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "insurance-ai | Automation Chat", template: "%s | insurance-ai" },
  description: "The insurance-ai AI copilot: lead to policy by conversation.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const saved = cookies().get(LOCALE_COOKIE)?.value;
  const locale = isLocale(saved) ? saved : DEFAULT_LOCALE;
  return (
    <html lang={locale} dir={localeDir(locale)} suppressHydrationWarning>
      <body className="bg-slate-50">
        <I18nProvider initialLocale={locale} cookieDomain={process.env.SSO_COOKIE_DOMAIN || undefined}>
          <CopilotProvider>
            <NotificationProvider>
              <SsoGate>{children}</SsoGate>
            </NotificationProvider>
          </CopilotProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
