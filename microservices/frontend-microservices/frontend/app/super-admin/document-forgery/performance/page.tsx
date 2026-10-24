"use client";
import { useEffect,useState } from "react";
import DocumentForgeryPerformance from "@/components/DocumentForgeryPerformance";
import "../../../admin/document-intelligence/workspace.css";
export default function PerformancePage() {
  const [allowed,setAllowed]=useState<boolean | null>(null);
  useEffect(()=>{setAllowed(localStorage.getItem("user_role") === "SuperAdmin");},[]);
  if(allowed === null)return <p className="p-8">Loading…</p>;
  if(!allowed)return <p className="p-8">SuperAdmin access required.</p>;
  return <DocumentForgeryPerformance />;
}
