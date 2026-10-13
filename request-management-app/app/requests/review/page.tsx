"use client";

import { tx } from "@/lib/i18n/tx";
import RequestList, { PageHeader, Stat } from "@/components/RequestList";
import { useSummary } from "@/components/RequestsShell";
import { Empty } from "@/components/ui";

// Requests assigned to the user, and unclaimed requests in their team's queue. Never their own requests.
export default function ReviewQueuePage() {
  const { summary } = useSummary();
  if (summary && !summary.can_review) {
    return <div className="px-6 py-10"><Empty title={tx("Your role doesn't review requests.")} hint={tx("Requests you raise are under “My requests”.")} /></div>;
  }
  return (
    <div className="mx-auto w-full max-w-screen-2xl space-y-5 px-6 py-5">
      <PageHeader title={tx("Review queue")} subtitle={tx("Requests assigned to you and open requests in your team's queue. Open one to start the review.")} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={tx("Assigned to you")} value={summary?.assigned_to_me} tone="blue" />
        <Stat label={tx("Unclaimed in your queue")} value={summary?.queue_unclaimed} tone="amber" />
        <Stat label={tx("Overdue")} value={summary?.overdue_for_me} tone="red" />
      </div>
      <RequestList scope="review" emptyTitle={tx("Nothing is waiting for your review.")} />
    </div>
  );
}
