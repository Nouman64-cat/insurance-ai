"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { requestsApi, RequestsError, type RequestDetail } from "@/lib/requestsApi";
import { PageHeader } from "@/components/RequestList";
import { NewRequestForm } from "@/components/RequestForm";
import { Empty, ErrorNote, Spinner } from "@/components/ui";

// Edit a draft, or the proposal of a request returned for more information (saving that starts a new revision; the
// submitted one is kept unchanged for the record).
export default function EditRequestPage({ params }: { params: { id: string } }) {
  const [req, setReq] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<RequestsError | null>(null);

  useEffect(() => {
    requestsApi.get(params.id).then(setReq).catch((e) => setError(e as RequestsError));
  }, [params.id]);

  if (error) return <div className="mx-auto max-w-3xl px-6 py-10"><ErrorNote message={error.message} /></div>;
  if (!req) return <Spinner />;
  if (!req.allowed_actions.includes("edit_draft")) {
    return <div className="mx-auto max-w-3xl px-6 py-10"><Empty title={tx("This request can't be edited now.")}
      action={<Link href={`/requests/${req.id}`} className="text-xs font-semibold text-blue-600">{tx("Back to the request")}</Link>} /></div>;
  }
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 px-6 py-5">
      <PageHeader title={tx("Edit {ref}", { ref: req.reference_no })}
        subtitle={req.review_status === "NEEDS_INFORMATION"
          ? tx("Your changes become a new revision. Resubmit from the request page when you're ready.")
          : tx("Changes are saved to the draft. Nothing is sent until you submit.")} />
      <Suspense fallback={<Spinner />}><NewRequestForm editing={req} /></Suspense>
    </div>
  );
}
