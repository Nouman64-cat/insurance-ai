"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function OrganizationsRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/admin/leads?add=corporate");
  }, [router]);

  return (
    <div className="flex items-center justify-center min-h-[60vh] font-sans">
      <div className="flex flex-col items-center justify-center gap-2">
        <div className="animate-spin h-7 w-7 text-blue-500 rounded-full border-2 border-slate-100 border-t-blue-500" />
        <span className="text-xs text-slate-400">Redirecting to Leads Hub...</span>
      </div>
    </div>
  );
}
