import type { Metadata } from "next";
import { ClientLayout } from "./ClientLayout";
import { NotificationProvider } from "@/components/NotificationContext";
import { cookies } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, localeDir } from "@/lib/i18n/config";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: {
    default: "insurance-ai | Underwriting Portal",
    template: "%s | insurance-ai",
  },
  description:
    "AI-powered multi-tenant insurance underwriting and risk assessment platform.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const saved = cookies().get(LOCALE_COOKIE)?.value;
  const locale = isLocale(saved) ? saved : DEFAULT_LOCALE;
  return (
    <html lang={locale} dir={localeDir(locale)} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              // The dark-mode switch was removed: always light, even if an old session saved a dark theme.
              try { localStorage.removeItem('theme'); } catch (e) {}
              document.documentElement.classList.remove('dark');
            `,
          }}
        />
      </head>
      <I18nProvider initialLocale={locale} cookieDomain={process.env.SSO_COOKIE_DOMAIN || undefined}>
        <NotificationProvider>
          <ClientLayout>{children}</ClientLayout>
        </NotificationProvider>
      </I18nProvider>
    </html>
  );
}

