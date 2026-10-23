import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Forgery Detection | Insurance AI",
  description:
    "Inspect document integrity, review forensic evidence, and test document analysis.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
