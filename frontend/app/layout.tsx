import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ClientLayout } from "./ClientLayout";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

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
    <html lang="en" className={inter.variable}>
      <ClientLayout>{children}</ClientLayout>
    </html>
  );
}

