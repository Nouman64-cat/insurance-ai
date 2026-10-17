"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { tx } from "@/lib/i18n/tx";

export default function PostIssuanceRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/policy-issuance");
  }, [router]);

  return (
    <div className="py-20 flex flex-col items-center justify-center text-center">
      <div className="animate-spin h-6 w-6 rounded-full border-2 border-slate-200 border-t-blue-600 mb-3" />
      <p className="text-sm font-semibold text-slate-600">{tx("Opening policies…")}</p>
    </div>
  );
}
