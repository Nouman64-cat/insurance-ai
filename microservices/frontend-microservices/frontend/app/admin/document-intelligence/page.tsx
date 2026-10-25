"use client";
import { useEffect, useState } from "react";
import DocumentIntelligenceWorkspace from "@/components/DocumentIntelligenceWorkspace";
import "./workspace.css";
export default function DocumentIntelligencePage() {
  const [allowed,setAllowed]=useState<boolean | null>(null);
  useEffect(()=>{setAllowed(localStorage.getItem("user_role") === "Admin");},[]);
  if (allowed === null) return <p className="p-8">Loading…</p>;
  if (!allowed) return <div className="p-8"><h1 className="text-xl font-semibold">Access denied</h1><p className="mt-2">Document Intelligence requires a tenant Admin account.</p></div>;
  return <DocumentIntelligenceWorkspace />;
}
