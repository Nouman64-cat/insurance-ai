"use client";

import Link from "next/link";
import { tx } from "@/lib/i18n/tx";
import RequestList, { PageHeader, Stat } from "@/components/RequestList";
import { useSummary } from "@/components/RequestsShell";
import { Empty, secondaryButton } from "@/components/ui";

// Every submitted request in the tenant, for administrators: overdue work, reassignment, failed executions.
export default function TenantQueuePage() {
  const { summary } = useSummary();
  if (summary && !summary.is_admin) {
    return <div className="px-6 py-10"><Empty title={tx("The tenant queue is for administrators.")} /></div>;
  }
  return (
    <div className="mx-auto w-full max-w-screen-2xl space-y-5 px-6 py-6">
      <PageHeader title={tx("Tenant queue")} subtitle={tx("All submitted requests in your tenant. Open a request to reassign it or retry a failed execution.")}>
        <Link href="/requests/routing" className={secondaryButton}>{tx("Routing rules")}</Link>
      </PageHeader>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={tx("Open")} value={summary?.tenant_open} tone="blue" hint={tx("Submitted, in review or waiting for information")} />
        <Stat label={tx("Overdue")} value={summary?.tenant_overdue} tone="red" hint={tx("Past the time to decide")} />
        <Stat label={tx("Failed executions")} value={summary?.tenant_failed_executions} tone="amber" hint={tx("Approved, but not applied yet")} />
      </div>
      <RequestList
        scope="tenant"
        presets={[
          { key: "all", label: tx("All"), filters: {} },
          { key: "open", label: tx("Open"), count: summary?.tenant_open, filters: { status: "SUBMITTED,IN_REVIEW,NEEDS_INFORMATION" } },
          { key: "overdue", label: tx("Overdue"), count: summary?.tenant_overdue, filters: { overdue: true } },
          { key: "unassigned", label: tx("Unassigned"), filters: { assignee: "unassigned", status: "SUBMITTED,IN_REVIEW,NEEDS_INFORMATION" } },
          { key: "failed", label: tx("Failed executions"), count: summary?.tenant_failed_executions, filters: { execution_status: "FAILED" } },
        ]}
        emptyTitle={tx("No requests have been submitted in your tenant yet.")}
      />
    </div>
  );
}
