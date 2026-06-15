import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Navigation } from "@/components/Navigation";
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
      <body className="min-h-screen flex flex-col">
        <Navigation />
        <main className="flex-1">{children}</main>
        <footer className="bg-slate-900 border-t border-slate-800 py-3 px-6">
          <p className="text-center text-xs text-slate-500">
            insurance-ai Underwriting Portal — Prototype v0.1.0 &nbsp;·&nbsp; Strictly Confidential
          </p>
        </footer>
      </body>
    </html>
  );
}
