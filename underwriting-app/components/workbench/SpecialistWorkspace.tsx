"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import api from "@/app/services/api";
import { updateUnderwritingTrack, type UnderwritingReview, type UnderwritingReviewStatus } from "@/app/services/cases";
import { getArtifactUrl } from "@/app/services/artifacts";
import { useWorkbenchUser } from "./SsoGate";
import { Pagination, usePagination } from "@/components/Pagination";
import { tx } from "@/lib/i18n/tx";

export const trackForRole = (role: string) => role === "Medical Underwriter" ? "medical" : role === "Financial Underwriter" ? "financial" : null;
const LABELS: Record<UnderwritingReviewStatus, string> = { PENDING: "Not started", IN_REVIEW: "In review", CLEARED: "Cleared", REFERRED: "Referred", DECLINED: "Declined" };
const TONES: Record<UnderwritingReviewStatus, string> = { PENDING: "bg-slate-100 text-slate-600", IN_REVIEW: "bg-blue-50 text-blue-700", CLEARED: "bg-emerald-50 text-emerald-700", REFERRED: "bg-amber-50 text-amber-800", DECLINED: "bg-rose-50 text-rose-700" };
type ReviewRow = { id: string; reference: string; customer_name: string; product_name: string | null; coverage_amount: number | null; on_hold: boolean; hold_reason: string | null; review: UnderwritingReview };
type Workspace = ReviewRow & { read_only: boolean; documents: { id: string; name: string; type: string; status: string }[]; track: string; evidence: Record<string, unknown>; assessment: { score: number; reasons: unknown[]; created_at: string } | null };
function valueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return tx("Not provided");
  if (typeof value === "boolean") return tx(value ? "Yes" : "No");
  if (Array.isArray(value)) return value.length ? value.map(valueText).join("\n") : tx("Not provided");
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([key, v]) => `${key.replace(/_/g, " ")}: ${valueText(v)}`).join("\n");
  return String(value);
}
function Badge({ status }: { status: UnderwritingReviewStatus }) {
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${TONES[status]}`}>{tx(LABELS[status])}</span>;
}

/** Specialist roles never mount the general workbench pages or their action handlers. */
export default function RoleWorkspace({ children }: { children: ReactNode }) {
  const user = useWorkbenchUser();
  const track = trackForRole(user.role_name);
  const pathname = usePathname();
  return track ? <SpecialistWorkspace key={track + pathname} track={track} /> : <>{children}</>;
}

function SpecialistWorkspace({ track }: { track: "medical" | "financial" }) {
  const user = useWorkbenchUser();
  const pathname = usePathname();
  const caseId = pathname.startsWith("/case/") ? pathname.split("/")[2] : null;
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [ownership, setOwnership] = useState("mine");
  const [note, setNote] = useState("");
  const [decision, setDecision] = useState<UnderwritingReviewStatus>("IN_REVIEW");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const label = track === "medical" ? "Medical Underwriting" : "Financial Underwriting";
  const root = `/tenants/${user.tenant_id}/underwriting/reviews`;
  const load = async () => {
    setLoading(true); setError("");
    try {
      if (caseId) {
        const { data } = await api.get<Workspace>(`${root}/${caseId}`);
        setWorkspace(data); setNote(data.review.note ?? ""); setDecision(data.review.status === "PENDING" ? "IN_REVIEW" : data.review.status);
      } else { const { data } = await api.get<ReviewRow[]>(root); setRows(data); }
    } catch (err: any) { setError(err?.response?.data?.detail ?? tx("Could not load underwriting reviews.")); }
    finally { setLoading(false); }
  };
  useEffect(() => { setWorkspace(null); setSaved(""); void load(); }, [caseId, root]);
  const openDocument = async (id: string) => {
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try { const url = await getArtifactUrl(id); if (tab) tab.location.href = url; }
    catch { tab?.close(); setError(tx("Could not open the document.")); }
  };
  const save = async () => {
    if (!caseId || !user.tenant_id || !workspace || workspace.read_only) return;
    setSaving(true); setError(""); setSaved("");
    try {
      const review = await updateUnderwritingTrack(user.tenant_id, caseId, track, { status: decision, note });
      setWorkspace({ ...workspace, review }); setSaved(tx("Review saved. Final application approval is a separate step."));
    } catch (err: any) { setError(err?.response?.data?.detail ?? tx("Could not save the review.")); }
    finally { setSaving(false); }
  };
  const scoped = rows.filter((r) => ownership === "available" ? !r.review.assigned_user_id : ownership === "mine" ? r.review.assigned_user_id === user.id : true)
    .filter((r) => `${r.customer_name} ${r.reference} ${r.product_name ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()));
  const filtered = scoped.filter((r) => filter === "ALL" || r.review.status === filter);
  const { pageItems, pagination } = usePagination(filtered, 12, `${ownership}:${filter}:${search}`);
  return <div className="mx-auto max-w-7xl space-y-5 px-5 py-6 sm:px-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>{caseId && <Link href="/underwriting" className="mb-2 inline-block text-xs font-semibold text-blue-600">← {tx("Review queue")}</Link>}
        <p className="text-xs font-semibold uppercase tracking-wider text-blue-600">{tx("Specialist review")}</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">{tx(label)}</h1>
        <p className="mt-1 text-sm text-slate-500">{tx(track === "medical" ? "Review health declarations, medical evidence and medical risk for assigned applications." : "Review declared income, existing cover and financial risk for assigned applications.")}</p>
      </div><button onClick={() => void load()} disabled={loading || saving} className="rounded-xl border bg-white px-4 py-2 text-sm font-semibold text-slate-600 disabled:opacity-50">{tx("Refresh")}</button>
    </header>
    {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</p>}
    {saved && <p role="status" className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">{saved}</p>}
    {loading ? <div role="status" className="py-20 text-center text-sm text-slate-500">{tx("Loading reviews…")}</div> : caseId ? workspace && <>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-white p-5">
        <div><h2 className="text-lg font-bold text-slate-900">{workspace.customer_name}</h2><p className="mt-1 text-sm text-slate-500">{workspace.reference.replace(/^CASE-/, "APP-")} · {workspace.product_name ?? tx("No product")}</p><p className="mt-1 text-xs text-slate-500">{tx("Assignee")}: {workspace.review.assigned_user_name ?? tx("Unassigned — saving assigns this review to you")}</p></div><Badge status={workspace.review.status} />
      </div>
      {workspace.on_hold && <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{tx("Application on hold")}: {workspace.hold_reason}. {tx("Review changes are disabled until the hold is released.")}</p>}
      {workspace.read_only && !workspace.on_hold && <p className="rounded-xl bg-slate-100 p-4 text-sm text-slate-700">{tx("This application is closed for specialist review.")}</p>}
      <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
        <section className="rounded-2xl border bg-white p-5"><h2 className="font-bold text-slate-900">{tx("Review evidence")}</h2>
          <dl className="mt-4 divide-y divide-slate-100">{Object.entries(workspace.evidence).map(([key, value]) => <div key={key} className="py-3"><dt className="text-xs font-semibold text-slate-500">{tx(key)}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-800">{valueText(value)}</dd></div>)}</dl>
        </section>
        <div className="space-y-5">
          <section className="rounded-2xl border bg-white p-5"><h2 className="font-bold text-slate-900">{tx("Supporting documents")}</h2>{workspace.documents.length ? <ul className="mt-3 space-y-2">{workspace.documents.map((d) => <li key={d.id}><button onClick={() => void openDocument(d.id)} className="text-left text-sm font-semibold text-blue-600">{d.name} ↗</button><p className="text-xs text-slate-500">{d.type} · {d.status}</p></li>)}</ul> : <p className="mt-3 text-sm text-slate-500">{tx("No supporting documents are available for this review.")}</p>}</section>
          <section className="rounded-2xl border bg-white p-5"><h2 className="font-bold text-slate-900">{tx("AI risk evidence")}</h2>{workspace.assessment ? <><p className="mt-3 text-3xl font-bold text-blue-700">{workspace.assessment.score}<span className="text-sm text-slate-400"> / 100</span></p><p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{valueText(workspace.assessment.reasons)}</p><p className="mt-2 text-xs text-slate-400">{workspace.assessment.created_at}</p></> : <p className="mt-3 text-sm text-slate-500">{tx("No current assessment is available. Do not interpret missing evidence as clearance.")}</p>}</section>
          <section className="rounded-2xl border bg-white p-5"><h2 className="font-bold text-slate-900">{tx("Your review")}</h2><p className="mt-1 text-xs text-slate-500">{tx("This records your specialist review only; it does not approve or issue the policy.")}</p>
            <label className="mt-4 block text-sm font-semibold text-slate-700">{tx("Review status")}<select value={decision} onChange={(e) => setDecision(e.target.value as UnderwritingReviewStatus)} disabled={workspace.read_only || saving} className="mt-2 w-full rounded-xl border bg-white p-2.5 text-sm">{Object.entries(LABELS).filter(([key]) => key !== "PENDING").map(([key, label]) => <option key={key} value={key}>{tx(label)}</option>)}</select></label>
            <label className="mt-4 block text-sm font-semibold text-slate-700">{tx("Review notes and rationale")}<textarea value={note} onChange={(e) => setNote(e.target.value)} rows={5} maxLength={2000} disabled={workspace.read_only || saving} className="mt-2 w-full rounded-xl border p-3 text-sm font-normal" /></label>
            <button onClick={() => void save()} disabled={saving || workspace.read_only || (["CLEARED", "REFERRED", "DECLINED"].includes(decision) && !note.trim())} className="mt-4 w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40">{tx(saving ? "Saving…" : "Save review")}</button>
          </section>
        </div>
      </div>
    </> : <>
      <div className="flex flex-wrap gap-3"><select aria-label={tx("Assignment")} value={ownership} onChange={(e) => setOwnership(e.target.value)} className="rounded-xl border bg-white px-3 py-2 text-sm"><option value="mine">{tx("Assigned to me")}</option><option value="available">{tx("Unassigned")}</option><option value="all">{tx("My reviews and unassigned")}</option></select><input aria-label={tx("Search applications")} placeholder={tx("Search applicant, application or product…")} value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-64 flex-1 rounded-xl border bg-white px-4 py-2 text-sm" /></div>
      <div className="flex flex-wrap gap-2">{["ALL", ...Object.keys(LABELS)].map((key) => <button key={key} onClick={() => setFilter(key)} aria-pressed={filter === key} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${filter === key ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200"}`}>{tx(key === "ALL" ? "All" : LABELS[key as UnderwritingReviewStatus])} <span className="opacity-60">{scoped.filter((r) => key === "ALL" || r.review.status === key).length}</span></button>)}</div>
      <div className="overflow-x-auto rounded-2xl border bg-white"><table className="w-full text-left text-sm"><thead className="border-b bg-slate-50 text-xs uppercase text-slate-500"><tr>{["Applicant", "Application", "Product", "Your review", "Assignee", "Action"].map((label) => <th key={label} className="px-5 py-3">{tx(label)}</th>)}</tr></thead><tbody className="divide-y">{pageItems.map((row) => <tr key={row.id} className="hover:bg-slate-50"><td className="px-5 py-4 font-semibold text-slate-900">{row.customer_name}{row.on_hold && <span className="block text-xs text-amber-700">{tx("On hold")}</span>}</td><td className="px-5 py-4 font-mono text-xs text-slate-500">{row.reference.replace(/^CASE-/, "APP-")}</td><td className="px-5 py-4 text-slate-600">{row.product_name ?? "—"}</td><td className="px-5 py-4"><Badge status={row.review.status} /></td><td className="px-5 py-4 text-slate-500">{row.review.assigned_user_name ?? tx("Unassigned")}</td><td className="px-5 py-4"><Link className="font-semibold text-blue-600" href={`/case/${row.id}`}>{tx("Open review")} →</Link></td></tr>)}</tbody></table>{!filtered.length && <p className="px-5 py-16 text-center text-sm text-slate-500">{tx("No reviews match this queue. Check unassigned applications or ask an admin to assign a review.")}</p>}</div>
      <Pagination pagination={pagination} noun={tx("reviews")} />
    </>}
  </div>;
}
