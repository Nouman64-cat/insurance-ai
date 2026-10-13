"use client";

import Link from "next/link";
import { tx } from "@/lib/i18n/tx";
import RequestList, { PageHeader, Stat } from "@/components/RequestList";
import { useSummary } from "@/components/RequestsShell";
import { Empty } from "@/components/ui";

// Every submitted request in the tenant, for administrators: overdue work, reassignment, failed executions.
export default function TenantQueuePage() {
  const { summary } = useSummary();
  if (summary && !summary.is_admin) {
    return <div className="px-6 py-10"><Empty title={tx("The tenant queue is for administrators.")} /></div>;
  }
  return (
    <div className="mx-auto w-full max-w-screen-2xl space-y-5 px-6 py-5">
      <PageHeader title={tx("Tenant queue")} subtitle={tx("All submitted requests in your tenant. Open a request to reassign it or retry a failed execution.")}>
        <Link href="/requests/routing" className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">{tx("Routing rules")}</Link>
      </PageHeader>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={tx("Open")} value={summary?.tenant_open} tone="blue" />
        <Stat label={tx("Overdue")} value={summary?.tenant_overdue} tone="red" />
        <Stat label={tx("Failed executions")} value={summary?.tenant_failed_executions} tone="amber" />
      </div>
      <RequestList scope="tenant" emptyTitle={tx("No requests have been submitted in your tenant yet.")} />
    </div>
  );
}
