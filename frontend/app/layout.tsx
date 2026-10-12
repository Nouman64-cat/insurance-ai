import type { Metadata } from "next";
import { ClientLayout } from "./ClientLayout";
import { NotificationProvider } from "@/components/NotificationContext";
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
  return (
    <html lang="en" suppressHydrationWarning>
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
      <NotificationProvider>
        <ClientLayout>{children}</ClientLayout>
      </NotificationProvider>
    </html>
  );
}

