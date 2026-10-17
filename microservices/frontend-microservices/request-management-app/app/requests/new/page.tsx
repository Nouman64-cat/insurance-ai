"use client";

import { Suspense } from "react";
import { tx } from "@/lib/i18n/tx";
import { PageHeader } from "@/components/RequestList";
import { NewRequestForm } from "@/components/RequestForm";
import { Spinner } from "@/components/ui";

export default function NewRequestPage() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 px-6 py-5">
      <PageHeader title={tx("New request")} subtitle={tx("The right reviewer is chosen automatically from your tenant's routing rules.")} />
      <Suspense fallback={<Spinner />}><NewRequestForm /></Suspense>
    </div>
  );
}
