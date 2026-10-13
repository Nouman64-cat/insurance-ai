"use client";

import Link from "next/link";
import { tx } from "@/lib/i18n/tx";
import RequestList, { PageHeader, Stat } from "@/components/RequestList";
import { useSummary } from "@/components/RequestsShell";

// Requests the signed-in user raised, drafts included.
export default function MyRequestsPage() {
  const { summary } = useSummary();
  return (
    <div className="mx-auto w-full max-w-screen-2xl space-y-5 px-6 py-5">
      <PageHeader title={tx("My requests")} subtitle={tx("Requests you raised: drafts, those under review, and their outcomes.")}>
        <Link href="/requests/new" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">{tx("+ New request")}</Link>
      </PageHeader>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={tx("Open")} value={summary?.my_open} tone="blue" />
        <Stat label={tx("Waiting for your information")} value={summary?.my_needs_information} tone="amber" />
        <Stat label={tx("Drafts")} value={summary?.my_drafts} />
      </div>
      <RequestList scope="mine" showRequester={false} emptyTitle={tx("You haven't raised any requests yet.")}
        emptyHint={tx("Use “New request” to ask for a decision, a customer profile correction, or to dispute a commission.")} />
    </div>
  );
}
