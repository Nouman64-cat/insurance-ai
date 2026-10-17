"use client";
import { ErrorState } from "@/components/ui";
export default function PortalError({ error, reset }: { error: Error; reset: () => void }) {
  return <div className="card"><ErrorState error={error} onRetry={reset} /></div>;
}
