"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import FinanceDashboard from "@/components/finance/FinanceDashboard";

export default function FinancePage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    if (localStorage.getItem("user_role") === "Finance") setAllowed(true);
    else router.replace("/");
  }, [router]);
  return allowed ? <Suspense fallback={<p className="p-8">Loading payments…</p>}><FinanceDashboard /></Suspense> : null;
}
