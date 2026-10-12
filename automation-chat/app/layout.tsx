import type { Metadata } from "next";
import { CopilotProvider } from "@/components/CopilotContext";
import { NotificationProvider } from "@/components/NotificationContext";
import SsoGate from "@/components/sso/SsoGate";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "insurance-ai | Automation Chat", template: "%s | insurance-ai" },
  description: "The insurance-ai AI copilot: lead to policy by conversation.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-slate-50">
        <CopilotProvider>
          <NotificationProvider>
            <SsoGate>{children}</SsoGate>
          </NotificationProvider>
        </CopilotProvider>
      </body>
    </html>
  );
}
