"use client";

import { tx } from "@/lib/i18n/tx";
import RequestList, { PageHeader } from "@/components/RequestList";
import { useSummary } from "@/components/RequestsShell";
import { useSatelliteUser } from "@/components/satellite/SsoGate";
import { Empty } from "@/components/ui";

// Requests assigned to the user, and unclaimed requests in their team's queue. Never their own requests.
export default function ReviewQueuePage() {
  const { summary } = useSummary();
  const user = useSatelliteUser();
  if (summary && !summary.can_review) {
    return <div className="px-6 py-10"><Empty title={tx("Your role doesn't review requests.")} hint={tx("Requests you raise are under “My requests”.")} /></div>;
  }
  return (
    <div className="mx-auto w-full max-w-screen-2xl space-y-5 px-6 py-6">
      <PageHeader title={tx("Review queue")} subtitle={tx("Requests assigned to you and open requests in your team's queue. Open one to start the review.")} />
      <RequestList
        scope="review"
        presets={[
          { key: "all", label: tx("All open"), count: (summary?.assigned_to_me ?? 0) + (summary?.queue_unclaimed ?? 0), filters: {} },
          { key: "mine", label: tx("Assigned to me"), count: summary?.assigned_to_me, filters: { assignee: user.id } },
          { key: "queue", label: tx("Unclaimed in my team"), count: summary?.queue_unclaimed, filters: { assignee: "unassigned" } },
          { key: "overdue", label: tx("Overdue"), count: summary?.overdue_for_me, filters: { overdue: true } },
        ]}
        emptyTitle={tx("Nothing is waiting for your review.")}
        emptyHint={tx("New requests routed to you or your team appear here, and you get a notification.")}
      />
    </div>
  );
}
