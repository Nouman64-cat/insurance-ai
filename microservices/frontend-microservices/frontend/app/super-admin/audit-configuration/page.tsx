"use client";

import { useEffect, useState } from "react";
import api from "@/app/services/api";

import AuditConfigurationWorkspace, { type AuditSettings as Settings, type AuditConfiguration as Configuration } from "@/components/AuditConfigurationWorkspace";

export default function AuditConfiguration() {
  const [allowed,setAllowed]=useState<boolean|null>(null);
  const [saved,setSaved]=useState<Configuration|null>(null);
  const [draft,setDraft]=useState<Settings|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  const [confirmation,setConfirmation]=useState("");
  async function load() {
    setError("");setMessage("");
    try {const r=await api.get<Configuration>("/api/audit-configuration",{baseURL:""});setSaved(r.data);setDraft(r.data.settings);setConfirmation("");}
    catch(e) {setError(e instanceof Error ? e.message : "Could not load audit configuration.");}
  }
  useEffect(()=>{const ok=localStorage.getItem("user_role")==="SuperAdmin";setAllowed(ok);if(ok)void load();},[]);
  function change<K extends keyof Settings>(key:K,value:Settings[K]) {setDraft(d=>d ? {...d,[key]:value} : d);setMessage("");}
  async function save(e:React.FormEvent) {
    e.preventDefault();if(!saved || !draft)return;
    setBusy(true);setError("");setMessage("");
    try {
      const r=await api.put<Configuration>("/api/audit-configuration",{expected_revision:saved.revision,settings:draft,confirmation:confirmation || null},{baseURL:""});
      setSaved(r.data);setDraft(r.data.settings);setConfirmation("");
      setMessage(`Saved revision ${r.data.revision}. The configuration was applied and recorded in the audit trail.`);
    } catch(e) {setError(e instanceof Error ? e.message : "Could not save audit configuration.");}
    finally {setBusy(false);}
  }
  if(allowed===false)return <main className="p-8">Access denied. SuperAdmin only.</main>;
  return <AuditConfigurationWorkspace saved={saved} draft={draft} busy={busy} error={error} message={message}
    confirmation={confirmation} onChange={change} onConfirmation={setConfirmation} onReload={()=>void load()}
    onReset={()=>{if(saved)setDraft(saved.settings);setConfirmation("");setMessage("");}} onSave={save}/>;
}
