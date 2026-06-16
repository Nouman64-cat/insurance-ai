import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
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
      <body className="dashboard-shell min-h-screen flex bg-slate-50">
        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        <Sidebar />

        {/* ── Main column ─────────────────────────────────────────────────── */}
        <div className="flex flex-col flex-1 min-w-0 min-h-screen">
          <TopBar />

          {/* ── Page content ──────────────────────────────────────────────── */}
          <main className="flex-1 overflow-auto">
            {children}
          </main>

          {/* ── Footer ────────────────────────────────────────────────────── */}
          <footer className="border-t border-slate-200 bg-white py-2.5 px-6">
            <p className="text-center text-[10px] text-slate-400">
              insurance-ai Underwriting Portal — Prototype v0.1.0 &nbsp;·&nbsp; Strictly Confidential &nbsp;·&nbsp; Adamjee Life Assurance Co. Ltd.
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
