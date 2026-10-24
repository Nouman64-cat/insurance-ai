"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { tx } from "@/lib/i18n/tx";
import { useQueryState } from "@/lib/useQueryState";
import {
  KIND_LABEL, decide, getDraft, getItem, getKnowledge, getOverview, getRegistry, getVersions, listItems, listScans, parseExpected, scanNow, syncKnowledge,
  type DriftAction, type DriftHistory, type DriftItem, type DriftOverview, type KnowledgeRow, type ScanJob, type ScanRow, type WatchedItem, type WatchedVersion,
} from "@/lib/evalDrift";

type Tab = "queue" | "watched" | "scans" | "knowledge";
const SEV: Record<string, string> = { critical: "bg-red-50 text-red-700 border-red-200", high: "bg-orange-50 text-orange-700 border-orange-200", medium: "bg-blue-50 text-blue-700 border-blue-200", low: "bg-slate-50 text-slate-500 border-slate-200" };
const btn = "px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all disabled:opacity-40";
const btnPrimary = `${btn} bg-blue-600 text-white border-blue-600 hover:bg-blue-700`;
const btnGhost = `${btn} bg-white text-slate-600 border-slate-200 hover:border-slate-300`;
const err = (e: unknown) => ((e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail as string) ?? (e instanceof Error ? e.message : "Something went wrong.");
const when = (s?: string | null) => (s ? new Date(s).toLocaleString() : "—");

function Badge({ children, cls }: { children: React.ReactNode; cls: string }) {
  return <span className={`inline-block px-2 py-0.5 rounded-full border text-[10px] font-semibold ${cls}`}>{children}</span>;
}

function Decision({ item, action, onClose, onDone }: { item: DriftItem; action: DriftAction; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [expected, setExpected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needs = action === "accept" && item.needs_expected;
  const reason = action !== "start" && action !== "reopen";
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await decide(item.id, action, note, needs ? parseExpected(expected) ?? undefined : undefined);
      onDone();
    } catch (e) {
      setError(typeof err(e) === "string" ? err(e) : JSON.stringify(err(e)));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-0 z-[70] bg-slate-900/40 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-5 space-y-3">
        <h3 className="text-sm font-bold text-slate-800 capitalize">{tx(action)} · {tx(KIND_LABEL[item.kind] ?? item.kind)}</h3>
        <p className="text-xs text-slate-500">{item.summary}</p>
        {reason && (
          <label className="block text-xs font-semibold text-slate-600">{tx("Reason (required)")}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className="mt-1 w-full border border-slate-200 rounded-lg p-2 text-xs font-normal" data-testid="decision-note" />
          </label>
        )}
        {needs && (
          <label className="block text-xs font-semibold text-slate-600">{tx("Expected value (written by you; JSON or plain text)")}
            <textarea value={expected} onChange={(e) => setExpected(e.target.value)} rows={4} className="mt-1 w-full border border-slate-200 rounded-lg p-2 text-xs font-mono font-normal" data-testid="decision-expected" />
            <span className="block text-[10px] font-normal text-slate-400 mt-1">{tx("The system never writes this value. It becomes the draft case's expected answer.")}</span>
          </label>
        )}
        {error && <div className="text-xs rounded-lg px-3 py-2 border bg-red-50 border-red-200 text-red-600">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>{tx("Cancel")}</button>
          <button type="button" className={btnPrimary} disabled={busy || (reason && !note.trim()) || (needs && !expected.trim())} onClick={submit} data-testid="decision-submit">{tx("Confirm")}</button>
        </div>
      </div>
    </div>
  );
}

function ItemDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [item, setItem] = useState<(DriftItem & { history: DriftHistory[] }) | null>(null);
  const [acting, setActing] = useState<DriftAction | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => getItem(id).then(setItem).catch((e) => setError(String(err(e)))), [id]);
  useEffect(() => { load(); }, [load]);
  if (!item) return <aside className="fixed right-0 top-0 bottom-0 w-full max-w-xl bg-white border-l border-slate-200 shadow-xl z-50 p-5 text-xs text-slate-400">{error ?? tx("Loading…")}</aside>;
  const actions: DriftAction[] = item.state === "open" ? ["start", "dismiss"] : item.state === "in_review" ? ["accept", "reject", "reopen"] : item.state === "rejected" || item.state === "dismissed" ? ["reopen"] : [];
  const diff = (item.detail?.diff as { path: string; before: unknown; after: unknown; change: string }[] | undefined) ?? [];
  return (
    <aside className="fixed right-0 top-0 bottom-0 w-full max-w-xl bg-white border-l border-slate-200 shadow-xl z-50 overflow-y-auto p-5 space-y-4" data-testid="item-drawer">
      <div className="flex items-start justify-between gap-3">
        <div><div className="flex gap-2 items-center"><Badge cls={SEV[item.severity]}>{item.severity}</Badge><Badge cls="bg-white text-slate-600 border-slate-200">{tx(KIND_LABEL[item.kind] ?? item.kind)}</Badge><Badge cls="bg-blue-50 text-blue-700 border-blue-200">{item.state.replace("_", " ")}</Badge></div>
          <p className="mt-2 text-sm font-semibold text-slate-800">{item.summary}</p></div>
        <button type="button" className={btnGhost} onClick={onClose}>{tx("Close")}</button>
      </div>
      <div className="flex flex-wrap gap-2 text-[11px]" data-testid="item-links">
        {item.dataset && <Link className="text-blue-600 hover:underline" href={`/super-admin/evaluation/datasets?dataset=${encodeURIComponent(item.dataset)}`}>{tx("Open the dataset")} ({item.dataset})</Link>}
        {item.registry_item?.startsWith("template:") && <Link className="text-blue-600 hover:underline" href={`/super-admin/templates?key=${encodeURIComponent(item.registry_item.slice(9))}`}>{tx("Open the template")}</Link>}
        {item.detail?.provenance?.template && <Link className="text-blue-600 hover:underline" href={`/super-admin/templates?key=${encodeURIComponent(String(item.detail.provenance.template))}`}>{tx("Open the template")}</Link>}
        <Link className="text-blue-600 hover:underline" href="/super-admin/evaluation/benchmarking">{tx("Run a benchmark")}</Link>
      </div>
      {item.affected_cases.length > 0 && <div><div className="text-[11px] font-bold text-slate-500 mb-1">{tx("Cases affected")}</div><div className="flex flex-wrap gap-1">{item.affected_cases.map((c) => <span key={c} className="px-2 py-0.5 rounded bg-slate-100 text-[11px] font-mono text-slate-600">{c}</span>)}</div></div>}
      {diff.length > 0 && (
        <div><div className="text-[11px] font-bold text-slate-500 mb-1">{tx("What changed")} (v{item.from_version} → v{item.to_version})</div>
          <div className="rounded-lg border border-slate-200 divide-y divide-slate-100 text-[11px]">{diff.slice(0, 20).map((d, i) => (
            <div key={i} className="p-2"><span className="font-mono text-slate-700">{d.path || "content"}</span> <span className="text-slate-400">{d.change}</span>
              <div className="text-red-600 break-all">{d.before !== null && d.before !== undefined && `− ${JSON.stringify(d.before).slice(0, 200)}`}</div>
              <div className="text-emerald-700 break-all">{d.after !== null && d.after !== undefined && `+ ${JSON.stringify(d.after).slice(0, 200)}`}</div></div>))}</div></div>
      )}
      {item.kind !== "config_changed" && Object.keys(item.detail ?? {}).length > 0 && <pre className="text-[10px] bg-slate-50 border border-slate-200 rounded-lg p-2 overflow-x-auto max-h-48">{JSON.stringify(item.detail, null, 1)}</pre>}
      {item.decision_note && <div className="text-xs rounded-lg border border-slate-200 p-3"><div className="font-bold text-slate-600">{tx("Decision")} · {when(item.decided_at)}</div><div className="mt-1 text-slate-600">{item.decision_note}</div>{item.expected && <pre className="mt-2 text-[10px] bg-slate-50 rounded p-2">{JSON.stringify(item.expected, null, 1)}</pre>}</div>}
      {error && <div className="text-xs rounded-lg px-3 py-2 border bg-red-50 border-red-200 text-red-600">{error}</div>}
      <div className="flex gap-2 flex-wrap">
        {actions.map((a) => <button key={a} type="button" className={a === "accept" || a === "start" ? btnPrimary : btnGhost} onClick={() => setActing(a)} data-testid={`act-${a}`}>{tx(a[0].toUpperCase() + a.slice(1))}</button>)}
        {item.state === "accepted" && item.expected && <button type="button" className={btnGhost} onClick={() => getDraft(item.id).then((d) => setDraft(JSON.stringify(d.draft, null, 2))).catch((e) => setError(String(err(e))))}>{tx("Prepare draft case")}</button>}
      </div>
      {draft && <div><div className="text-[11px] text-slate-500 mb-1">{tx("Copy this into the Dataset Manager as a new case. Nothing in the dataset was changed.")}</div><pre className="text-[10px] bg-slate-50 border border-slate-200 rounded-lg p-2 overflow-x-auto" data-testid="draft">{draft}</pre></div>}
      <div><div className="text-[11px] font-bold text-slate-500 mb-1">{tx("History")}</div>
        <ul className="text-[11px] text-slate-600 space-y-1">{item.history.map((h, i) => <li key={i}>{when(h.at)} · {h.from ?? "new"} → <b>{h.to}</b> · {h.by}{h.note ? ` · ${h.note}` : ""}</li>)}</ul></div>
      {acting && <Decision item={item} action={acting} onClose={() => setActing(null)} onDone={() => { setActing(null); load(); onChanged(); }} />}
    </aside>
  );
}

function Queue({ overview, onChanged }: { overview: DriftOverview | null; onChanged: () => void }) {
  const [items, setItems] = useState<DriftItem[]>([]);
  const [state, setState] = useQueryState("state", "active");
  const [kind, setKind] = useQueryState("kind");
  const [severity, setSeverity] = useQueryState("severity");
  const [q, setQ] = useQueryState("q", "", { replace: true });
  const [openId, setOpen] = useQueryState("item");
  const open = openId || null;
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => listItems({ state: state === "all" ? "" : state, kind, severity, q }).then((r) => setItems(r.items)).catch((e) => setError(String(err(e)))), [state, kind, severity, q]);
  useEffect(() => { load(); }, [load]);
  const sel = "border border-slate-200 rounded-lg px-2 py-1.5 text-xs bg-white";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <select className={sel} value={state} onChange={(e) => setState(e.target.value)} aria-label="state">{["active", "open", "in_review", "accepted", "rejected", "dismissed", "cleared", "all"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select>
        <select className={sel} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="kind"><option value="">{tx("All kinds")}</option>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{tx(l)}</option>)}</select>
        <select className={sel} value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="severity"><option value="">{tx("Any severity")}</option>{["critical", "high", "medium", "low"].map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <input className={`${sel} w-56`} placeholder={tx("Search")} value={q} onChange={(e) => setQ(e.target.value)} />
        {overview && <span className="text-[11px] text-slate-400 ml-auto">{overview.open} {tx("need a decision")}</span>}
      </div>
      {error && <div className="text-xs rounded-lg px-3 py-2 border bg-red-50 border-red-200 text-red-600">{error}</div>}
      <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
        <table className="w-full text-xs" data-testid="queue-table">
          <thead><tr className="text-left text-slate-400 border-b border-slate-100"><th className="px-3 py-2 font-semibold">{tx("Severity")}</th><th className="font-semibold">{tx("Kind")}</th><th className="font-semibold">{tx("What")}</th><th className="font-semibold">{tx("State")}</th><th className="font-semibold">{tx("Opened")}</th></tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-slate-400">{tx("Nothing to review.")}</td></tr>}
            {items.map((i) => (
              <tr key={i.id} className="border-t border-slate-100 hover:bg-blue-50/40 cursor-pointer align-top" onClick={() => setOpen(i.id)} data-testid="queue-row">
                <td className="px-3 py-2"><Badge cls={SEV[i.severity]}>{i.severity}</Badge></td>
                <td className="py-2 text-slate-600 whitespace-nowrap">{tx(KIND_LABEL[i.kind] ?? i.kind)}</td>
                <td className="py-2 pr-3 text-slate-700">{i.summary}{i.affected_cases.length > 0 && <span className="block text-[10px] text-slate-400">{i.affected_cases.slice(0, 4).join(", ")}{i.affected_cases.length > 4 ? ` +${i.affected_cases.length - 4}` : ""}</span>}</td>
                <td className="py-2 whitespace-nowrap text-slate-600">{i.state.replace("_", " ")}</td>
                <td className="py-2 whitespace-nowrap text-slate-400">{when(i.opened_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && <ItemDrawer id={open} onClose={() => setOpen("")} onChanged={() => { load(); onChanged(); }} />}
    </div>
  );
}

function Watched() {
  const [items, setItems] = useState<WatchedItem[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ title: string; dependents: { dataset: string; version: string; case_id: string }[]; versions: WatchedVersion[] } | null>(null);
  useEffect(() => { getRegistry().then(setItems).catch(() => setItems([])); }, []);
  useEffect(() => { if (sel) getVersions(sel).then(setDetail).catch(() => setDetail(null)); }, [sel]);
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto max-h-[70vh] overflow-y-auto">
        <table className="w-full text-xs" data-testid="watched-table"><thead><tr className="text-left text-slate-400 border-b border-slate-100"><th className="px-3 py-2 font-semibold">{tx("Item")}</th><th className="font-semibold">{tx("Type")}</th><th className="font-semibold">v</th><th className="font-semibold">{tx("Cases")}</th></tr></thead>
          <tbody>{items.map((i) => <tr key={i.key} onClick={() => setSel(i.key)} className={`border-t border-slate-100 cursor-pointer hover:bg-blue-50/40 ${sel === i.key ? "bg-blue-50" : ""}`}><td className="px-3 py-2 text-slate-700">{i.title}<span className="block text-[10px] font-mono text-slate-400">{i.key}</span></td><td className="text-slate-500">{i.type}</td><td className="text-slate-600">{i.version}</td><td className="text-slate-600">{i.dependent_cases}</td></tr>)}</tbody></table>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs space-y-3">
        {!detail ? <p className="text-slate-400">{tx("Pick an item to see its versions and the cases that depend on it.")}</p> : (
          <>
            <div className="font-bold text-slate-800">{detail.title}</div>
            <div><div className="text-[11px] font-bold text-slate-500 mb-1">{tx("Cases that depend on it")} ({detail.dependents.length})</div>
              <div className="flex flex-wrap gap-1">{detail.dependents.length === 0 ? <span className="text-slate-400">{tx("None: the dataset does not cover this item.")}</span> : detail.dependents.map((d) => <span key={d.dataset + d.case_id} className="px-2 py-0.5 rounded bg-slate-100 font-mono text-[11px] text-slate-600">{d.case_id}</span>)}</div></div>
            {detail.versions.map((v) => (
              <div key={v.version} className="border-t border-slate-100 pt-2"><b>v{v.version}</b> <span className="text-slate-400">{when(v.captured_at)} · {v.captured_from}</span>
                {v.diff.slice(0, 6).map((d, i) => <div key={i} className="font-mono text-[10px] text-slate-500 break-all">{d.path || "content"} · {d.change}</div>)}</div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function Scans({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<{ scans: ScanRow[]; jobs: ScanJob[] }>({ scans: [], jobs: [] });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => listScans().then(setData).catch(() => undefined), []);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  async function run() {
    setBusy(true);
    try {
      const r = await scanNow();
      setMsg(`${tx("Registry read")}: ${r.registry.watched} ${tx("items")}, ${r.registry.changed} ${tx("changed")}. ${r.job ? tx("A dataset scan was queued; the worker runs it.") : r.note ?? ""}`);
      load(); onChanged();
    } catch (e) { setMsg(String(err(e))); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3"><button type="button" className={btnPrimary} disabled={busy} onClick={run} data-testid="scan-now">{tx("Scan now")}</button>{msg && <span className="text-xs text-slate-500" data-testid="scan-msg">{msg}</span>}</div>
      <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto"><table className="w-full text-xs" data-testid="scans-table">
        <thead><tr className="text-left text-slate-400 border-b border-slate-100"><th className="px-3 py-2 font-semibold">{tx("When")}</th><th className="font-semibold">{tx("Dataset")}</th><th className="font-semibold">{tx("New")}</th><th className="font-semibold">{tx("Seen again")}</th><th className="font-semibold">{tx("Cleared")}</th></tr></thead>
        <tbody>{data.jobs.filter((j) => !["succeeded"].includes(j.state)).map((j) => <tr key={j.id} className="border-t border-slate-100 bg-blue-50/40"><td className="px-3 py-2">{when(j.created_at)}</td><td>{j.dataset} {j.version}</td><td colSpan={3} className="text-slate-500">{j.state}{j.error ? ` · ${j.error}` : ""}</td></tr>)}
          {data.scans.map((s) => <tr key={s.scan_id} className="border-t border-slate-100"><td className="px-3 py-2 whitespace-nowrap">{when(s.created_at)}</td><td>{s.dataset} {s.version}</td><td>{s.counts.created ?? 0}</td><td>{s.counts.seen_again ?? 0}</td><td>{s.counts.cleared ?? 0}</td></tr>)}
          {data.scans.length === 0 && data.jobs.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-slate-400">{tx("No scans yet.")}</td></tr>}</tbody></table></div>
    </div>
  );
}

function Knowledge() {
  const [rows, setRows] = useState<KnowledgeRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => getKnowledge().then(setRows).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);
  async function sync() {
    try {
      const r = await syncKnowledge();
      setMsg(Object.entries(r.synced).map(([k, v]) => `${k}: ${v.status}${v.reason ? ` (${v.reason})` : v.error ? ` (${v.error})` : ""}`).join(" · ") || tx("Already up to date."));
      load();
    } catch (e) { setMsg(String(err(e))); }
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">{tx("When a template is published, the agent assistant's knowledge base is updated with its new text. This shows which version the assistant knows.")}</p>
      <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto"><table className="w-full text-xs" data-testid="knowledge-table">
        <thead><tr className="text-left text-slate-400 border-b border-slate-100"><th className="px-3 py-2 font-semibold">{tx("Template")}</th><th className="font-semibold">{tx("Published")}</th><th className="font-semibold">{tx("Assistant knows")}</th><th /></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.template} className="border-t border-slate-100"><td className="px-3 py-2 text-slate-700">{r.title}</td><td>v{r.published_version}</td><td>{r.assistant_knows ? `v${r.assistant_knows}` : "—"}</td><td><Badge cls={r.current ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-orange-50 text-orange-700 border-orange-200"}>{r.current ? tx("current") : tx("behind")}</Badge></td></tr>)}</tbody></table></div>
      <div className="flex items-center gap-3"><button type="button" className={btnPrimary} onClick={sync} data-testid="kb-sync">{tx("Update knowledge base")}</button>{msg && <span className="text-xs text-slate-500">{msg}</span>}</div>
    </div>
  );
}

export default function DriftWorkspace() {
  const [tabParam, setTab] = useQueryState("view", "queue");
  const tab = (["queue", "watched", "scans", "knowledge"].includes(tabParam) ? tabParam : "queue") as Tab;
  const [overview, setOverview] = useState<DriftOverview | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => { getOverview().then(setOverview).catch(() => undefined); setTick((t) => t + 1); }, []);
  useEffect(() => { getOverview().then(setOverview).catch(() => undefined); }, []);
  const tabs: [Tab, string][] = [["queue", "Review queue"], ["watched", "Watched items"], ["scans", "Scans"], ["knowledge", "Assistant knowledge"]];
  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div><h2 className="text-xl font-bold text-slate-900">{tx("Drift Monitor")}</h2>
        <p className="text-xs text-slate-500 mt-1">{tx("Finds where the evaluation datasets may be out of date, and queues each finding for a person to decide. Nothing changes a golden case until you accept it and publish a new version.")}</p></div>
      {overview && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="overview">
          {[[tx("Need a decision"), overview.open], [tx("Critical or high"), (overview.open_by_severity.critical ?? 0) + (overview.open_by_severity.high ?? 0)], [tx("Accepted"), overview.by_state.accepted ?? 0], [tx("Last scan"), overview.last_scan ? when(overview.last_scan.at) : tx("never")]].map(([l, v]) => (
            <div key={String(l)} className="rounded-xl border border-slate-200 bg-white p-3"><div className="text-[11px] text-slate-400">{l}</div><div className="text-lg font-bold text-slate-800">{v}</div></div>))}
        </div>
      )}
      <div className="flex gap-1 border-b border-slate-200">{tabs.map(([t, l]) => <button key={t} type="button" onClick={() => setTab(t)} className={`px-3 py-2 text-xs font-semibold -mb-px border-b-2 ${tab === t ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-700"}`}>{tx(l)}</button>)}</div>
      {tab === "queue" && <Queue key={tick} overview={overview} onChanged={refresh} />}
      {tab === "watched" && <Watched />}
      {tab === "scans" && <Scans onChanged={refresh} />}
      {tab === "knowledge" && <Knowledge />}
    </div>
  );
}
