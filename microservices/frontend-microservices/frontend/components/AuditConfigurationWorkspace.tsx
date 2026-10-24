"use client";

import type { FormEvent, ReactNode } from "react";
import Link from "next/link";

export type AuditSettings = {
  hot_retention_months:number; archiving_enabled:boolean; archive_schedule:"monthly"|"continuous";
  archive_compression:"zstd"|"none"; auto_hot_cleanup:boolean; cleanup_mode:"detach"|"drop";
  cleanup_safety_days:number; archive_test_mode:boolean; archive_test_hot_seconds:number;
  archive_interval_seconds:number; lock_mode:"GOVERNANCE"|"COMPLIANCE"; lock_days:number; environment_label:string;
};
export type AuditConfiguration = {revision:number; settings:AuditSettings; updated_at:string; updated_by:string; propagation_seconds:number};
type Props = {
  saved:AuditConfiguration|null; draft:AuditSettings|null; busy:boolean; error:string; message:string; confirmation:string;
  onChange:<K extends keyof AuditSettings>(key:K,value:AuditSettings[K])=>void;
  onConfirmation:(value:string)=>void; onReload:()=>void; onReset:()=>void; onSave:(e:FormEvent)=>void;
};
const input="mt-1.5 h-10 w-full min-w-0 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";

function Icon({kind}:{kind:"archive"|"database"|"lock"|"settings"}) {
  const paths={archive:"M3 4h18v4H3zM5 8v12h14V8M9 12h6",database:"M20 6c0 2-4 3-8 3S4 8 4 6s4-3 8-3 8 1 8 3ZM4 6v12c0 2 4 3 8 3s8-1 8-3V6M4 12c0 2 4 3 8 3s8-1 8-3",lock:"M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3",settings:"M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6"};
  return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]}/></svg>;
}
function Section({title,description,icon,children,disabled}:{title:string;description:string;icon:"archive"|"database"|"lock"|"settings";children:ReactNode;disabled:boolean}) {
  return <fieldset disabled={disabled} className="min-w-0 rounded-xl border border-slate-200 bg-white shadow-sm" aria-label={title}>
    <legend className="sr-only">{title}</legend>
    <div className="flex gap-3 border-b border-slate-100 px-4 py-3.5 sm:px-5"><span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600"><Icon kind={icon}/></span><div className="min-w-0"><h2 className="text-sm font-semibold text-slate-900">{title}</h2><p className="mt-0.5 text-xs leading-5 text-slate-500">{description}</p></div></div>
    <div className="space-y-4 p-4 sm:p-5">{children}</div>
  </fieldset>;
}
function Switch({label,hint,checked,disabled,onChange}:{label:string;hint:string;checked:boolean;disabled?:boolean;onChange:(value:boolean)=>void}) {
  return <label className={`flex items-center justify-between gap-4 ${disabled ? "opacity-50" : "cursor-pointer"}`}><span className="min-w-0"><span className="block text-sm font-medium text-slate-800">{label}</span><span className="mt-0.5 block text-xs leading-5 text-slate-500">{hint}</span></span><span className="relative inline-flex shrink-0"><input type="checkbox" role="switch" aria-label={label} className="peer sr-only" checked={checked} disabled={disabled} onChange={e=>onChange(e.target.checked)}/><span className="relative h-5 w-9 rounded-full bg-slate-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform after:content-[''] peer-checked:bg-blue-600 peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2"/></span></label>;
}
function Field({label,unit,children}:{label:string;unit?:string;children:ReactNode}) {
  return <label className="block min-w-0 text-xs font-medium text-slate-600"><span className="flex flex-wrap items-baseline justify-between gap-x-2"><span>{label}</span>{unit && <span className="font-normal text-slate-400">{unit}</span>}</span>{children}</label>;
}
function Note({title,children}:{title:string;children:ReactNode}) {
  return <details className="border-t border-slate-100 pt-3 text-xs text-slate-500"><summary className="cursor-pointer font-medium text-slate-600">{title}</summary><p className="mt-2 leading-5">{children}</p></details>;
}

export default function AuditConfigurationWorkspace({saved,draft,busy,error,message,confirmation,onChange:change,onConfirmation,onReload,onReset,onSave}:Props) {
  const changed=saved && draft ? (Object.keys(draft) as (keyof AuditSettings)[]).filter(k=>draft[k]!==saved.settings[k]).length : 0;
  const needsConfirmation=!!draft?.auto_hot_cleanup && draft.cleanup_mode==="drop" && !(saved?.settings.auto_hot_cleanup && saved.settings.cleanup_mode==="drop");
  return <main className="mx-auto w-full max-w-[1600px] space-y-4 px-4 py-5 sm:px-6 lg:px-7">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400"><span>SuperAdmin</span><span>/</span><span className="text-slate-600">Security &amp; Compliance</span></div><h1 className="text-xl font-semibold tracking-tight text-slate-900">Audit Configuration</h1><p className="mt-1 text-sm text-slate-500">Control how audit history is archived, protected and retained.</p></div><Link href="/admin/audit-trail" className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900">Open Audit Trail <span aria-hidden="true">↗</span></Link></header>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}{!saved && <button type="button" className="ml-3 underline" onClick={onReload}>Retry</button>}</div>}
    {message && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</p>}
    {!saved || !draft ? <div className="grid animate-pulse gap-4 lg:grid-cols-2" aria-label="Loading audit configuration"><div className="h-64 rounded-xl border border-slate-200 bg-slate-50"/><div className="h-64 rounded-xl border border-slate-200 bg-slate-50"/></div> : <>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2 text-[11px]"><span className="inline-flex items-center gap-1.5 font-medium text-emerald-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500"/>Live updates · no restart required</span><span className="text-slate-400">Saved configuration · revision {saved.revision}</span></div><div className="grid grid-cols-2 gap-px bg-slate-100 lg:grid-cols-4">{[
        ["Archiving",saved.settings.archiving_enabled ? "Enabled" : "Paused"],
        ["Archive eligibility",saved.settings.archive_test_mode ? `${saved.settings.archive_test_hot_seconds}s · test window` : `${saved.settings.hot_retention_months} months`],
        ["PostgreSQL cleanup",saved.settings.auto_hot_cleanup ? `Automatic · ${saved.settings.cleanup_mode}` : "Manual"],
        ["Object retention",saved.settings.lock_days ? `${saved.settings.lock_days} days · ${saved.settings.lock_mode.toLowerCase()}` : "No retention lock"],
      ].map(([label,value])=><div key={label} className="min-w-0 bg-white px-4 py-3"><p className="text-[11px] text-slate-400">{label}</p><p className="mt-1 truncate text-sm font-semibold text-slate-800" title={value}>{value}</p></div>)}</div></div>
      <form onSubmit={onSave} className="space-y-4">
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,1fr)]">
          <div className="min-w-0 space-y-4">
            <Section title="Archiving" description="Move eligible audit history into encrypted MinIO archives." icon="archive" disabled={busy}>
              <Switch label="Archive to MinIO" hint="Pause archive work without stopping audit ingestion or retrieval." checked={draft.archiving_enabled} onChange={v=>change("archiving_enabled",v)}/>
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                <Field label="Default hot retention" unit="months"><input type="number" required min={0} max={1200} className={input} value={draft.hot_retention_months} onChange={e=>change("hot_retention_months",Number(e.target.value))}/></Field>
                <Field label="Planning interval" unit="seconds"><input type="number" required min={5} max={86400} className={input} value={draft.archive_interval_seconds} onChange={e=>change("archive_interval_seconds",Number(e.target.value))}/></Field>
                <Field label="Archive schedule"><select className={input} value={draft.archive_schedule} onChange={e=>change("archive_schedule",e.target.value as AuditSettings["archive_schedule"])}><option value="monthly">Monthly boundaries</option><option value="continuous">Rolling retention window</option></select></Field>
                <Field label="Compression"><select className={input} value={draft.archive_compression} onChange={e=>change("archive_compression",e.target.value as AuditSettings["archive_compression"])}><option value="zstd">Zstandard (zstd)</option><option value="none">No compression</option></select></Field>
              </div>
              <Note title="How retention and running jobs are handled">The default updates system-managed category policies. Explicit category and tenant policies override it, and a chain uses its longest applicable window. Already-running and retried jobs keep their original settings. Pausing also stops automatic cleanup; existing archives stay available.</Note>
            </Section>
            <Section title="PostgreSQL cleanup" description="Remove hot copies only after their archives are verified and eligible." icon="database" disabled={busy}>
              <Switch label="Automatic cleanup" hint="Only eligible monthly partitions can be detached or dropped." checked={draft.auto_hot_cleanup} onChange={v=>change("auto_hot_cleanup",v)}/>
              <div className="grid gap-4 sm:grid-cols-2"><Field label="Cleanup mode"><select className={input} value={draft.cleanup_mode} onChange={e=>change("cleanup_mode",e.target.value as AuditSettings["cleanup_mode"])}><option value="detach">Detach · keep recoverable tables</option><option value="drop">Drop · permanently remove partitions</option></select></Field><Field label="New archive safety period" unit="days"><input type="number" required min={0} max={3650} step="any" className={input} value={draft.cleanup_safety_days} onChange={e=>change("cleanup_safety_days",Number(e.target.value))}/></Field></div>
              <div className={`rounded-lg px-3 py-2.5 text-xs leading-5 ${draft.cleanup_mode==="drop" ? "bg-amber-50 text-amber-800" : "bg-slate-50 text-slate-500"}`}>{draft.cleanup_mode==="detach" ? "Detach retains recoverable tables and their disk usage in PostgreSQL." : "Drop permanently removes PostgreSQL partitions. Verified MinIO archives remain."}</div>
              {needsConfirmation && <Field label="Confirm automatic permanent deletion"><input required pattern="ENABLE-AUTOMATIC-DROP" placeholder="Type ENABLE-AUTOMATIC-DROP" className={input} value={confirmation} onChange={e=>onConfirmation(e.target.value)}/></Field>}
              <Note title="Cleanup safeguards">Full archive verification, retention policy permission, the safety deadline and absence of legal holds are required. Existing archives retain their recorded safety deadlines. Archives in MinIO are never automatically deleted.</Note>
            </Section>
          </div>
          <div className="min-w-0 space-y-4">
            <Section title="Object protection" description="Retention locks for newly planned MinIO archives." icon="lock" disabled={busy}>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Object Lock mode"><select className={input} value={draft.lock_mode} onChange={e=>change("lock_mode",e.target.value as AuditSettings["lock_mode"])}><option value="GOVERNANCE">Governance</option><option value="COMPLIANCE">Compliance</option></select></Field><Field label="Lock duration" unit="days"><input type="number" required min={0} max={36500} className={input} value={draft.lock_days} onChange={e=>change("lock_days",Number(e.target.value))}/></Field></div>
              <p className="text-xs leading-5 text-slate-500">Existing locks are never shortened. Set 0 to disable locks on new objects.{draft.lock_mode==="COMPLIANCE" && <span className="mt-1 block font-medium text-amber-700">Compliance locks cannot be shortened or bypassed on existing objects.</span>}</p>
            </Section>
            <Section title="Environment & testing" description="Label this installation and control local test windows." icon="settings" disabled={busy}>
              <Field label="Environment label"><input required maxLength={80} pattern="[a-zA-Z0-9 _.-]+" className={input} value={draft.environment_label} onChange={e=>{change("environment_label",e.target.value);if(e.target.value!=="local-dev")change("archive_test_mode",false);}}/></Field>
              <Switch label="Local test mode" hint="Use seconds instead of the normal retention window." disabled={draft.environment_label!=="local-dev"} checked={draft.archive_test_mode} onChange={v=>change("archive_test_mode",v)}/>
              <Field label="Test hot window" unit="seconds"><input type="number" required min={1} max={86400} step="any" disabled={!draft.archive_test_mode} className={input} value={draft.archive_test_hot_seconds} onChange={e=>change("archive_test_hot_seconds",Number(e.target.value))}/></Field>
              {draft.archive_test_mode && <p className="rounded-lg bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800">The shortened window applies to all eligible audit history. Checkpoint signing is still required.</p>}
              <p className="text-xs leading-5 text-slate-500">Test mode requires <code className="text-[11px] text-slate-600">local-dev</code>. The label does not change the cryptographic environment ID.</p>
            </Section>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-slate-400"><span className="max-w-full truncate" title={saved.updated_by}>Saved by {saved.updated_by}</span><span>Updated {new Date(saved.updated_at).toLocaleString()}</span></div>
        <div className="sticky bottom-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur sm:px-5"><div><p className={`text-xs font-semibold ${changed ? "text-amber-700" : "text-slate-700"}`} aria-live="polite">{changed ? `${changed} unsaved ${changed===1 ? "change" : "changes"}` : "All changes saved"}</p><p className="mt-0.5 text-[11px] text-slate-400">New requests update immediately · idle workers within {saved.propagation_seconds}s</p></div><div className="flex items-center gap-2">{changed ? <button type="button" disabled={busy} onClick={onReset} className="h-9 rounded-lg px-3 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50">Discard changes</button> : <button type="button" disabled={busy} onClick={onReload} className="h-9 rounded-lg px-3 text-xs font-medium text-slate-500 hover:bg-slate-100 disabled:opacity-50">Refresh</button>}<button disabled={busy || !changed} className="inline-flex h-9 items-center justify-center rounded-lg bg-blue-600 px-4 text-xs font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-default disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none">{busy ? "Saving…" : "Save and apply"}</button></div></div>
      </form>
    </>}
  </main>;
}
