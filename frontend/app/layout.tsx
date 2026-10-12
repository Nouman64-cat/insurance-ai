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
              if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                document.documentElement.classList.add('dark');
              }
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

