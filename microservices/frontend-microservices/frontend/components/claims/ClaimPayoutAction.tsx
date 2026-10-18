"use client";

import { tx } from "@/lib/i18n/tx";

export default function ClaimPayoutAction({ role, eligible, disabled, onPayout }: {
  role: string | null; eligible: boolean; disabled?: boolean; onPayout: () => void;
}) {
  if (!eligible || !role) return null;
  if (role !== "Finance") return <p className="text-xs text-slate-600" role="status">
    {tx("Awaiting Finance: the claim is approved. A Finance user must record the payout. Ask your administrator to provision a Finance account if needed.")}
  </p>;
  return <button type="button" disabled={disabled} onClick={onPayout}
    className="rounded-lg border border-blue-600 px-3 py-2 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50 disabled:opacity-50">
    {tx("Issue payout")}
  </button>;
}
