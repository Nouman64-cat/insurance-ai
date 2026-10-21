"use client";

import { useCallback, useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import {
  ArchiveEntry, ArchiveJob, ArchiveStatus, ArchiveVerificationResult, ArchivedEvent, CleanupPartition, JOB_LABEL, Retrieval, RetrievalCriteria, Tone,
  archiveApi, errorMessage, formatBytes, formatTime, relativeTime, shortHash,
} from "@/lib/audit";

const TONE: Record<Tone, { dot: string; text: string }> = {
  good: { dot: "bg-emerald-500", text: "text-emerald-700" },
  bad: { dot: "bg-rose-500", text: "text-rose-700" },
  wait: { dot: "bg-amber-500", text: "text-amber-700" },
  neutral: { dot: "bg-slate-300", text: "text-slate-500" },
};
const PAGE_SIZE = 8;

function Tile({ label, value, sub, tone = "neutral" }: { label: string; value: string; sub?: string; tone?: Tone }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{tx(label)}</p>
      <p className={`mt-1 flex items-center gap-1.5 text-sm font-semibold tabular-nums ${TONE[tone].text}`}>
        {tone !== "neutral" && <span className={`h-2 w-2 rounded-full ${TONE[tone].dot}`} aria-hidden="true" />}
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[11px] text-slate-400">{sub}</p>}
    </div>
  );
}

const flag = (v: boolean | null | undefined, yes: string, no: string): [string, Tone] => (v == null ? [tx("Unknown"), "neutral"] : v ? [yes, "good"] : [no, "bad"]);

function JobRow({ job, onRetry, canRetry }: { job: ArchiveJob; onRetry: (id: string) => void; canRetry: boolean }) {
  const failed = job.state === "FAILED";
  return (
    <tr className="border-t border-slate-100 align-top">
      <td className="px-3 py-2 tabular-nums">#{job.archive_number}</td>
      <td className="px-3 py-2 tabular-nums">{job.start_sequence.toLocaleString()}–{job.end_sequence.toLocaleString()}</td>
      <td className={`px-3 py-2 font-medium ${failed ? "text-rose-700" : "text-slate-700"}`}>
        {tx(JOB_LABEL[job.state])}{failed && job.resume_state ? <span className="font-normal text-slate-400"> · {tx("resumes at")} {tx(JOB_LABEL[job.resume_state])}</span> : null}
      </td>
      <td className="px-3 py-2 text-slate-500">
        {failed ? <><span className="font-mono text-[11px]">{job.last_error_code}</span> {job.last_error}</> : relativeTime(job.updated_at)}
        {failed && <div className="text-[11px] text-slate-400">{job.next_attempt_at ? tx("next attempt {0}", { 0: relativeTime(job.next_attempt_at) }) : tx("needs attention; no automatic retry")} · {tx("attempt")} {job.attempts}</div>}
      </td>
      <td className="px-3 py-2 text-right">{failed && canRetry && <button type="button" onClick={() => onRetry(job.job_id)} className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50">{tx("Retry now")}</button>}</td>
    </tr>
  );
}

export default function ArchivePanel({ chainId, isSuperAdmin }: { chainId: string; isSuperAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ArchiveStatus | null>(null);
  const [unavailable, setUnavailable] = useState("");
  const [archives, setArchives] = useState<ArchiveEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [verdict, setVerdict] = useState<Record<string, ArchiveVerificationResult | "loading">>({});
  const [criteria, setCriteria] = useState<RetrievalCriteria>({});
  const [retrieval, setRetrieval] = useState<Retrieval | null>(null);
  const [rpage, setRpage] = useState(1);
  const [rEvents, setREvents] = useState<{ items: ArchivedEvent[]; total: number } | null>(null);
  const [cleanup, setCleanup] = useState<CleanupPartition[] | null>(null);
  const [holdReason, setHoldReason] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await archiveApi.status());
      const list = await archiveApi.catalog(page, PAGE_SIZE, chainId);
      setArchives(list.items); setTotal(list.total); setUnavailable("");
    } catch (err) { setUnavailable(errorMessage(err, tx("Archive information is not available."))); }
  }, [page, chainId]);

  useEffect(() => { if (open) { refresh(); const t = setInterval(refresh, 15000); return () => clearInterval(t); } }, [open, refresh]);
  useEffect(() => { setPage(1); }, [chainId]);

  // Follow a retrieval until it is ready (it runs in the background on the server).
  useEffect(() => {
    if (!retrieval || !["PENDING", "RUNNING"].includes(retrieval.state)) return;
    const t = setInterval(async () => { try { setRetrieval(await archiveApi.retrieval(retrieval.retrieval_id)); } catch { /* keep polling */ } }, 2000);
    return () => clearInterval(t);
  }, [retrieval]);
  useEffect(() => {
    if (retrieval?.state === "READY") archiveApi.retrievalEvents(retrieval.retrieval_id, rpage, 10).then(setREvents).catch(() => undefined);
  }, [retrieval?.state, retrieval?.retrieval_id, rpage]);

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key); setMessage(null);
    try { const text = await fn(); if (text) setMessage({ ok: true, text }); await refresh(); }
    catch (err) { setMessage({ ok: false, text: errorMessage(err, tx("The action could not be completed.")) }); }
    finally { setBusy(""); }
  };

  const verify = async (id: string, deep: boolean) => {
    setVerdict((v) => ({ ...v, [id]: "loading" }));
    try { const r = await archiveApi.verify(id, deep); setVerdict((v) => ({ ...v, [id]: r })); refresh(); }
    catch (err) { setVerdict((v) => { const { [id]: _x, ...rest } = v; return rest; }); setMessage({ ok: false, text: errorMessage(err, tx("Verification failed.")) }); }
  };

  const download = async (a: ArchiveEntry) => {
    await run(`ev-${a.archive_id}`, async () => {
      const blob = await archiveApi.evidence(a.archive_id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `audit-archive-${String(a.archive_number).padStart(6, "0")}-evidence.zip`; link.click();
      URL.revokeObjectURL(url);
      return tx("Evidence package downloaded.");
    });
  };

  const search = () => run("retrieve", async () => {
    const body = Object.fromEntries(Object.entries({ chain_id: chainId, ...criteria }).filter(([, v]) => v !== "" && v !== undefined)) as RetrievalCriteria;
    setRpage(1); setREvents(null); setRetrieval(await archiveApi.retrieve(body));
    return tx("Retrieval requested. Archived events are restored to a staging area, never into the live chain.");
  });

  const sum = status?.summary;
  const [storeText, storeTone] = flag(status?.storage?.reachable, tx("Reachable"), tx("Unreachable"));
  const [lockText, lockTone] = flag(status?.storage?.object_lock && status?.storage?.versioning, tx("Locked & versioned"), tx("Lock/versioning missing"));
  const [keyText, keyTone] = flag(status?.master_key?.available, tx("Available"), tx("Missing"));
  const setC = (patch: RetrievalCriteria) => setCriteria((c) => ({ ...c, ...patch }));
  const input = "rounded border border-slate-300 bg-white px-2 py-1.5 text-xs";

  return (
    <section aria-label={tx("Archive & retention")} className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center justify-between px-4 py-3 text-left">
        <span>
          <span className="block text-sm font-semibold text-slate-900">{tx("Archive & retention")}</span>
          <span className="block text-xs text-slate-500">
            {sum ? tx("{0} events in {1} archives · {2} stored", { 0: sum.archived_events.toLocaleString(), 1: sum.archives, 2: formatBytes(sum.stored_bytes) }) : tx("Older history is compressed, encrypted and kept in cold storage; it stays searchable and verifiable.")}
          </span>
        </span>
        <span className="text-xs text-slate-400">{open ? tx("Hide") : tx("Show")}</span>
      </button>

      {open && (
        <div className="space-y-5 border-t border-slate-100 p-4">
          {unavailable && <p role="alert" className="text-sm text-rose-700">{unavailable}</p>}
          {message && <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-emerald-700" : "text-rose-700"}`}>{message.text}</p>}

          {status && sum && (
            <>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
                <Tile label="Archived events" value={sum.archived_events.toLocaleString()} sub={tx("{0} archives", { 0: sum.archives })} />
                <Tile label="Cold storage used" value={formatBytes(sum.stored_bytes)} sub={sum.compression_ratio ? tx("{0}× compression", { 0: sum.compression_ratio }) : undefined} />
                <Tile label="Hot events" value={status.hot.events.toLocaleString()} sub={status.hot.oldest_event_at ? tx("oldest {0}", { 0: relativeTime(status.hot.oldest_event_at) }) : undefined} />
                <Tile label="Archived range" value={sum.first_event_at ? formatTime(sum.first_event_at).slice(0, 10) : "—"} sub={sum.last_event_at ? tx("to {0}", { 0: formatTime(sum.last_event_at).slice(0, 10) }) : undefined} />
                <Tile label="Last archived" value={sum.last_archived_at ? relativeTime(sum.last_archived_at) : tx("Never")} />
                <Tile label="Object storage" value={storeText} tone={storeTone} sub={status.storage?.problem ?? undefined} />
                <Tile label="Immutability" value={lockText} tone={lockTone} sub={status.storage?.private ? tx("private bucket") : undefined} />
                <Tile label="Encryption key" value={keyText} tone={keyTone} />
              </div>
              <p className="text-xs text-slate-500">
                {tx("Hot window: {0} months · cleanup: {1} · safety period {2} days · compression {3} · {4}", {
                  0: status.config.hot_retention_months, 1: status.config.auto_hot_cleanup ? tx("automatic") : tx("manual only"),
                  2: status.config.cleanup_safety_days, 3: status.config.compression, 4: status.config.encryption })}
                {status.config.test_mode && <strong className="ms-2 text-amber-700">{tx("TEST MODE (short hot window)")}</strong>}
              </p>

              {(status.pending_jobs.length > 0 || status.failed_jobs.length > 0) && (
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="min-w-full text-xs">
                    <caption className="bg-slate-50 px-3 py-2 text-left text-xs font-semibold text-slate-700">{tx("Pending and failed jobs")}</caption>
                    <tbody>{[...status.failed_jobs, ...status.pending_jobs].map((j) => <JobRow key={j.job_id} job={j} canRetry={isSuperAdmin} onRetry={(id) => run("retry", async () => { await archiveApi.retry(id); return tx("Retry scheduled."); })} />)}</tbody>
                  </table>
                </div>
              )}
            </>
          )}

          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-xs">
              <caption className="bg-slate-50 px-3 py-2 text-left text-xs font-semibold text-slate-700">{tx("Archives")} ({total})</caption>
              <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                <tr>{["#", "Events (sequence)", "Period", "Size", "Retention", "Integrity", ""].map((h) => <th key={h} scope="col" className="px-3 py-2 text-left font-medium">{tx(h)}</th>)}</tr>
              </thead>
              <tbody>
                {archives.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">{tx("Nothing has been archived yet. Events move to cold storage once they are older than the hot window and covered by a signed checkpoint.")}</td></tr>}
                {archives.map((a) => {
                  const v = verdict[a.archive_id];
                  return (
                    <tr key={a.archive_id} className="border-t border-slate-100 align-top">
                      <td className="px-3 py-2 tabular-nums">{a.archive_number}</td>
                      <td className="px-3 py-2 tabular-nums">{a.event_count.toLocaleString()} <span className="text-slate-400">({a.start_sequence.toLocaleString()}–{a.end_sequence.toLocaleString()})</span></td>
                      <td className="px-3 py-2 text-slate-600">{formatTime(a.first_occurred_at).slice(0, 10)} → {formatTime(a.last_occurred_at).slice(0, 10)}</td>
                      <td className="px-3 py-2 tabular-nums">{formatBytes(a.size_bytes)} {a.ratio && <span className="text-slate-400">· {a.ratio}×</span>}</td>
                      <td className="px-3 py-2 text-slate-600">{a.retention_until ? tx("until {0}", { 0: a.retention_until }) : tx("kept indefinitely")}{a.cleanup_approved_at && <div className="text-[11px] text-slate-400">{tx("hot copy may be removed")}</div>}</td>
                      <td className="px-3 py-2">
                        {v === "loading" ? <span className="text-slate-400">{tx("Verifying…")}</span> : v ? (
                          <span className={v.state === "VERIFIED" ? "text-emerald-700" : "text-rose-700"}>
                            {v.state === "VERIFIED" ? (v.deep ? tx("Verified (every event)") : tx("Verified")) : tx("Failed")}
                            {v.findings.slice(0, 2).map((f) => <div key={f.code} className="text-[11px]"><span className="font-mono">{f.code}</span> {f.message}</div>)}
                          </span>
                        ) : <span className="text-slate-400">{tx("Not checked this session")}</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <button type="button" onClick={() => verify(a.archive_id, false)} className="me-1 rounded border border-slate-300 bg-white px-2 py-1 font-semibold text-slate-700 hover:bg-slate-50">{tx("Verify")}</button>
                        <button type="button" onClick={() => verify(a.archive_id, true)} title={tx("Download, decrypt and re-hash every event")} className="me-1 rounded border border-slate-300 bg-white px-2 py-1 font-semibold text-slate-700 hover:bg-slate-50">{tx("Deep verify")}</button>
                        <button type="button" disabled={busy === `ev-${a.archive_id}`} onClick={() => download(a)} className="rounded border border-slate-300 bg-white px-2 py-1 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">{tx("Evidence")}</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {total > PAGE_SIZE && (
              <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-3 py-2 text-xs">
                <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border border-slate-300 bg-white px-2 py-1 disabled:opacity-40">{tx("Previous")}</button>
                <button type="button" disabled={page * PAGE_SIZE >= total} onClick={() => setPage(page + 1)} className="rounded border border-slate-300 bg-white px-2 py-1 disabled:opacity-40">{tx("Next")}</button>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 p-3">
            <h3 className="text-xs font-semibold text-slate-700">{tx("Search archived history")}</h3>
            <p className="mt-0.5 text-[11px] text-slate-500">{tx("Matching events are read from cold storage, verified, and shown below as archived. They are not added back to the live chain.")}</p>
            <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
              <input className={input} placeholder={tx("Entity id")} onChange={(e) => setC({ entity_id: e.target.value.trim() })} />
              <input className={input} placeholder={tx("Case id")} onChange={(e) => setC({ case_id: e.target.value.trim() })} />
              <input className={input} placeholder={tx("Actor id")} onChange={(e) => setC({ actor_id: e.target.value.trim() })} />
              <input className={input} placeholder={tx("Module")} onChange={(e) => setC({ module: e.target.value.trim() })} />
              <label className="text-[11px] text-slate-500">{tx("From")}<input type="date" className={`${input} mt-0.5 w-full`} onChange={(e) => setC({ since: e.target.value ? `${e.target.value}T00:00:00Z` : "" })} /></label>
              <label className="text-[11px] text-slate-500">{tx("To")}<input type="date" className={`${input} mt-0.5 w-full`} onChange={(e) => setC({ until: e.target.value ? `${e.target.value}T23:59:59Z` : "" })} /></label>
              <label className="text-[11px] text-slate-500">{tx("Sequence from")}<input type="number" min={1} className={`${input} mt-0.5 w-full`} onChange={(e) => setC({ from_sequence: e.target.value ? Number(e.target.value) : undefined })} /></label>
              <label className="text-[11px] text-slate-500">{tx("Sequence to")}<input type="number" min={1} className={`${input} mt-0.5 w-full`} onChange={(e) => setC({ to_sequence: e.target.value ? Number(e.target.value) : undefined })} /></label>
            </div>
            <button type="button" disabled={busy === "retrieve"} onClick={search} className="mt-2 rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">{tx("Retrieve from archive")}</button>

            {retrieval && (
              <div className="mt-3 text-xs">
                <p className={retrieval.state === "FAILED" ? "text-rose-700" : "text-slate-600"}>
                  {retrieval.state === "READY" ? tx("{0} archived events retrieved and verified from {1} archive(s). Staged copy expires {2}.", { 0: retrieval.event_count, 1: retrieval.archives.length, 2: relativeTime(retrieval.expires_at) })
                    : retrieval.state === "FAILED" ? `${tx("Retrieval failed")}: ${retrieval.error}` : retrieval.state === "EXPIRED" ? tx("This staged copy has expired.") : tx("Retrieving and verifying…")}
                </p>
                {rEvents && rEvents.items.length > 0 && (
                  <div className="mt-2 overflow-x-auto rounded border border-slate-200">
                    <table className="min-w-full">
                      <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                        <tr>{["Time", "Action", "Entity", "Actor", "Seq", "Hash", ""].map((h) => <th key={h} scope="col" className="px-3 py-1.5 text-left font-medium">{tx(h)}</th>)}</tr>
                      </thead>
                      <tbody>
                        {rEvents.items.map((e) => (
                          <tr key={e.event_id} className="border-t border-slate-100">
                            <td className="whitespace-nowrap px-3 py-1.5 text-slate-600">{formatTime(e.timestamp)}</td>
                            <td className="px-3 py-1.5">{e.action}</td>
                            <td className="px-3 py-1.5 font-mono text-[11px] text-slate-500">{e.entity_type}{e.entity_id ? ` ${e.entity_id}` : ""}</td>
                            <td className="px-3 py-1.5 text-slate-600">{e.actor_id ?? "—"}</td>
                            <td className="px-3 py-1.5 tabular-nums">{e.sequence_number}</td>
                            <td className="px-3 py-1.5 font-mono text-[11px] text-slate-400">{shortHash(e.current_hash)}</td>
                            <td className="px-3 py-1.5"><span className="rounded border border-slate-300 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600" title={tx("Read from cold storage; hash chain and signed manifest verified")}>{tx("Archived · verified")}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-3 py-1.5">
                      <span className="tabular-nums">{rEvents.total.toLocaleString()} {tx("events")}</span>
                      <span className="flex gap-2">
                        <button type="button" disabled={rpage <= 1} onClick={() => setRpage(rpage - 1)} className="rounded border border-slate-300 bg-white px-2 py-0.5 disabled:opacity-40">{tx("Previous")}</button>
                        <button type="button" disabled={rpage * 10 >= rEvents.total} onClick={() => setRpage(rpage + 1)} className="rounded border border-slate-300 bg-white px-2 py-0.5 disabled:opacity-40">{tx("Next")}</button>
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {status && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="min-w-full text-xs">
                  <caption className="bg-slate-50 px-3 py-2 text-left text-xs font-semibold text-slate-700">{tx("Retention policy")}</caption>
                  <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                    <tr>{["Category", "Hot", "Cold", "Status"].map((h) => <th key={h} scope="col" className="px-3 py-1.5 text-left font-medium">{tx(h)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {status.policies.map((p) => (
                      <tr key={p.category} className="border-t border-slate-100">
                        <td className="px-3 py-1.5">{tx(p.category.replace(/_/g, " "))}</td>
                        <td className="px-3 py-1.5 tabular-nums">{p.hot_retention_months} {tx("months")}</td>
                        <td className="px-3 py-1.5 tabular-nums">{p.cold_retention_years ? `${p.cold_retention_years} ${tx("years")}` : tx("indefinite")}</td>
                        <td className={`px-3 py-1.5 ${p.approved ? "text-emerald-700" : "text-slate-500"}`}>{p.approved ? tx("Approved") : tx("Default, not approved")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500">{tx("Defaults are not legal retention periods. Archives are never deleted automatically; compliance approves the real periods.")}</p>
              </div>

              <div className="rounded-lg border border-slate-200">
                <h3 className="bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">{tx("Legal holds")} ({status.holds.length})</h3>
                <ul className="divide-y divide-slate-100 text-xs">
                  {status.holds.length === 0 && <li className="px-3 py-3 text-slate-400">{tx("No active holds.")}</li>}
                  {status.holds.map((h) => (
                    <li key={h.hold_id} className="flex items-start justify-between gap-2 px-3 py-2">
                      <span><span className="font-medium text-slate-700">{h.reason}</span>{h.case_reference && <span className="text-slate-400"> · {h.case_reference}</span>}<span className="block text-[11px] text-slate-400">{h.placed_by} · {relativeTime(h.placed_at)}</span></span>
                      {isSuperAdmin && <button type="button" onClick={() => { const r = window.prompt(tx("Reason for releasing this hold")); if (r) run("hold", async () => { await archiveApi.releaseHold(h.hold_id, r); return tx("Hold released."); }); }} className="rounded border border-slate-300 bg-white px-2 py-1 font-semibold text-slate-700">{tx("Release")}</button>}
                    </li>
                  ))}
                </ul>
                {isSuperAdmin && (
                  <div className="flex gap-2 border-t border-slate-100 p-2">
                    <input value={holdReason} onChange={(e) => setHoldReason(e.target.value)} placeholder={tx("Reason for a hold on this chain")} className={`${input} min-w-0 flex-1`} />
                    <button type="button" disabled={holdReason.trim().length < 3 || !chainId} onClick={() => run("hold", async () => { await archiveApi.placeHold({ chain_id: chainId, reason: holdReason.trim() }); setHoldReason(""); return tx("Legal hold placed."); })} className="rounded bg-slate-900 px-3 py-1 text-xs font-semibold text-white disabled:opacity-40">{tx("Place hold")}</button>
                  </div>
                )}
              </div>
            </div>
          )}

          {isSuperAdmin && status && (
            <div className="rounded-lg border border-slate-200 p-3 text-xs">
              <h3 className="font-semibold text-slate-700">{tx("Operations")}</h3>
              <p className="mt-0.5 text-[11px] text-slate-500">{tx("Archiving never removes anything from the database. Removing a fully archived month from hot storage is a separate, confirmed step, and the database refuses it unless every event in that month is archived, verified and not under legal hold.")}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={() => run("plan", async () => { const r = await archiveApi.plan(true); return r.planned.length ? tx("{0} archive job(s) would be created.", { 0: r.planned.length }) : tx("Nothing is due for archiving."); })} className="rounded border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700">{tx("Preview archiving (dry run)")}</button>
                <button type="button" onClick={() => run("plan", async () => { const r = await archiveApi.plan(false); return tx("{0} archive job(s) created; they run in the background.", { 0: r.planned.length }); })} className="rounded border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700">{tx("Archive now")}</button>
                <button type="button" onClick={() => run("cleanup", async () => { setCleanup((await archiveApi.cleanupPlan()).partitions); })} className="rounded border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700">{tx("Review hot cleanup")}</button>
              </div>
              {cleanup && (
                <div className="mt-2 overflow-x-auto rounded border border-slate-200">
                  <table className="min-w-full">
                    <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500"><tr>{["Month", "Events", "Status", "Why"].map((h) => <th key={h} scope="col" className="px-3 py-1.5 text-left font-medium">{tx(h)}</th>)}</tr></thead>
                    <tbody>{cleanup.filter((p) => p.events > 0).map((p) => (
                      <tr key={p.partition} className="border-t border-slate-100 align-top">
                        <td className="px-3 py-1.5 tabular-nums">{p.month}</td><td className="px-3 py-1.5 tabular-nums">{p.events.toLocaleString()}</td>
                        <td className={`px-3 py-1.5 font-medium ${p.status === "REMOVABLE" ? "text-emerald-700" : "text-slate-500"}`}>{tx(p.status === "REMOVABLE" ? "Can be removed" : p.status === "KEEP" ? "Current month" : "Kept")}</td>
                        <td className="px-3 py-1.5 text-slate-500">{p.reasons.join(" · ") || "—"}</td>
                      </tr>))}</tbody>
                  </table>
                  {cleanup.some((p) => p.status === "REMOVABLE") && (
                    <div className="border-t border-slate-100 bg-slate-50 p-2">
                      <button type="button" onClick={() => { if (window.confirm(tx("Detach the fully archived months from hot storage? The archives keep every event; the detached tables stay in the database and can be re-attached."))) run("cleanup", async () => { const r = await archiveApi.cleanup(false); setCleanup(r.partitions); return r.removed_months.length ? tx("Removed from hot storage: {0}", { 0: r.removed_months.join(", ") }) : tx("Nothing was removed."); }); }} className="rounded bg-rose-700 px-3 py-1.5 font-semibold text-white">{tx("Remove archived months from hot storage")}</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
