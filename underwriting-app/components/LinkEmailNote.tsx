"use client";

import { tx } from "@/lib/i18n/tx";

/** What happened to the customer's emailed copy of a link (e-application or medical exam). */
export type LinkDelivery = {
  emailed_to?: string | null;
  email_status?: "sent" | "failed" | "no_email" | string;
};

/** One-line summary for a toast. */
export function linkDeliveryText(d: LinkDelivery | null | undefined): string {
  if (d?.email_status === "sent" && d.emailed_to) return tx("Link emailed to {0}", { 0: d.emailed_to });
  if (d?.email_status === "failed") return tx("Couldn't email the link to {0} — share it manually", { 0: d.emailed_to ?? "" });
  return tx("No email on record for this customer — share the link manually");
}

export function LinkEmailNote({ delivery }: Readonly<{ delivery: LinkDelivery | null | undefined }>) {
  if (!delivery) return null;
  const sent = delivery.email_status === "sent";
  const failed = delivery.email_status === "failed";
  return (
    <p
      role="status"
      className={`mt-1.5 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium ${
        sent ? "bg-emerald-50 text-emerald-700" : failed ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-600"
      }`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 flex-shrink-0" aria-hidden>
        <rect x="3" y="5" width="18" height="14" rx="2" /><polyline points="3 7 12 13 21 7" />
      </svg>
      {linkDeliveryText(delivery)}
    </p>
  );
}
