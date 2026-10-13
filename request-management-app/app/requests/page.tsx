"use client";

import Link from "next/link";
import { tx } from "@/lib/i18n/tx";
import RequestList, { PageHeader } from "@/components/RequestList";
import { useSummary } from "@/components/RequestsShell";
import { primaryButton } from "@/components/ui";

// Requests the signed-in user raised, drafts included.
export default function MyRequestsPage() {
  const { summary } = useSummary();
  return (
    <div className="mx-auto w-full max-w-screen-2xl space-y-5 px-6 py-6">
      <PageHeader title={tx("My requests")} subtitle={tx("Requests you raised: drafts, those under review, and their outcomes.")}>
        <Link href="/requests/new" className={primaryButton}>{tx("+ New request")}</Link>
      </PageHeader>
      <RequestList
        scope="mine"
        showRequester={false}
        presets={[
          { key: "all", label: tx("All"), filters: {} },
          { key: "open", label: tx("In progress"), count: summary?.my_open, filters: { status: "SUBMITTED,IN_REVIEW,NEEDS_INFORMATION" } },
          { key: "info", label: tx("Needs your input"), count: summary?.my_needs_information, filters: { status: "NEEDS_INFORMATION" } },
          { key: "drafts", label: tx("Drafts"), count: summary?.my_drafts, filters: { status: "DRAFT" } },
          { key: "done", label: tx("Decided"), filters: { status: "APPROVED,REJECTED" } },
        ]}
        emptyTitle={tx("You haven't raised any requests yet.")}
        emptyHint={tx("Ask for a decision, correct a customer's contact details, or dispute a commission.")}
        emptyAction={<Link href="/requests/new" className={`${primaryButton} mt-2`}>{tx("+ New request")}</Link>}
      />
    </div>
  );
}
