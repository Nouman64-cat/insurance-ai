"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import api from "@/app/services/api";
import { updateUnderwritingTrack, type UnderwritingReview, type UnderwritingReviewStatus } from "@/app/services/cases";
import CaseWorkspaceHeader, { type CaseTab } from "@/components/case/CaseWorkspaceHeader";
import { fmtCoverage } from "@/lib/mock-data";
import { displayDate } from "@/lib/dateDisplay";
import { useNewArrivals, floatNew, useRevealNew, recentIds, NewArrivalsBanner, NEW_ARRIVAL_CLASS, scrollToFirstNew } from "@/lib/useNewArrivals";
import { downloadReviewReport } from "./reviewReportPdf";
import ClaimUnderwritingSummary from "./ClaimUnderwritingSummary";
import ClaimReviewChecks, { type ClaimCheck } from "./ClaimReviewChecks";
import ReviewDocuments, { isProcessing } from "./ReviewDocuments";
import TrackOperations from "./TrackOperations";
import { useCaseEvents } from "@/lib/agent/useCaseEvents";
import { useCoalescedRefresh } from "@/lib/liveRefresh";
import EApplicationPanel from "./EApplicationPanel";
import FinancialAIPanel, { type FinancialAI } from "./FinancialAIPanel";
import ApplicantPolicyTab from "./ApplicantPolicyTab";
import { getArtifactUrl } from "@/app/services/artifacts";
import { inviteEApplicationPart } from "@/app/services/eApplication";
import { notify, Toaster } from "./toast";
import { useWorkbenchUser } from "./SsoGate";
import { Pagination, usePagination } from "@/components/Pagination";
import { tx } from "@/lib/i18n/tx";
import { requirementState, statusLabel, STATE_TONE, type RequirementState } from "./requirementStatus";

export const trackForRole = (role: string) => role === "Medical Underwriter" ? "medical" : role === "Financial Underwriter" ? "financial" : null;
const LABELS: Record<UnderwritingReviewStatus, string> = { PENDING: "Not started", IN_REVIEW: "In review", CLEARED: "Cleared", REFERRED: "Referred", DECLINED: "Declined" };
const TONES: Record<UnderwritingReviewStatus, string> = { PENDING: "bg-slate-100 text-slate-600", IN_REVIEW: "bg-blue-50 text-blue-700", CLEARED: "bg-emerald-50 text-emerald-700", REFERRED: "bg-amber-50 text-amber-800", DECLINED: "bg-rose-50 text-rose-700" };
type Requirement = { key: string; label: string; status: string; section: CaseTab; detail?: string };
type RequiredDocument = { type: string; received: boolean };
type Outstanding = { code: string; reason: string; document_type: string | null; owner: "medical" | "financial" | null; can_upload: boolean; covered_by_exam?: boolean };
type ReviewRow = { id: string; claim_id?: string | null; reference: string; customer_name: string; product_name: string | null; coverage_amount: number | null; on_hold: boolean; hold_reason: string | null; created_at?: string; case_status?: string; closed?: boolean; review: UnderwritingReview };
type ClaimInfo = { id: string; claim_number: string | null; claim_type: string; submitted_amount: number; incident_date: string | null; referral_reason: string | null; referral_notes: string | null; ready: boolean; reviews: Record<string, { status: string; note: string | null }> };
type Workspace = ReviewRow & { claim_checks?: Record<string, ClaimCheck>; claim?: ClaimInfo | null; read_only: boolean; policy_linked: boolean; case_status: string; created_at: string; customer_cnic: string | null; coverage_amount: number | null; term_years: number | null; requirements: Requirement[]; required_documents: RequiredDocument[]; application_outstanding: Outstanding[]; ai_underwriting: FinancialAI | null; documents: { id: string; name: string; type: string; status: string; processing_stalled?: boolean; scope: string; ocr_text: string | null; extracted: unknown; quality_score: number; tampered: boolean }[]; track: string; evidence: Record<string, unknown>; assessment: { results: unknown; score: number; reasons: unknown[]; created_at: string } | null };
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
  return track && !pathname.startsWith("/case/") ? <SpecialistCaseWorkspace key={track + pathname} track={track} /> : <>{children}</>;
}

export function SpecialistCaseWorkspace({ track }: { track: "medical" | "financial" }) {
  const user = useWorkbenchUser();
  const pathname = usePathname();
  const router = useRouter();
  const caseId = pathname.startsWith("/case/") ? pathname.split("/")[2] : null;
  const [caseTab, setCaseTab] = useState<CaseTab>("overview");
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [note, setNote] = useState("");
  const [decision, setDecision] = useState<UnderwritingReviewStatus>("IN_REVIEW");
  const [saving, setSaving] = useState(false);
  const arrivalIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const arrivals = useNewArrivals(`specialist-queue:${track}`, arrivalIds, !loading && !caseId, recentIds(rows, (r) => r.id, (r) => r.created_at));
  const label = track === "medical" ? "Medical Underwriting" : "Financial Underwriting";
  const root = `/tenants/${user.tenant_id}/underwriting/reviews`;
  const load = async (silent = false) => {
    if (!silent) setLoading(true); setError("");
    try {
      if (caseId) {
        const { data } = await api.get<Workspace>(`${root}/${caseId}`);
        setWorkspace(data); if (!silent) { setNote(data.review.note ?? ""); setDecision(data.review.status === "PENDING" ? "IN_REVIEW" : data.review.status); }
      } else { const { data } = await api.get<ReviewRow[]>(root); setRows(data); }
    } catch (err: any) { setError(err?.response?.data?.detail ?? tx("Could not load underwriting reviews.")); }
    finally { if (!silent) setLoading(false); }
  };
  const liveRefresh = useCoalescedRefresh(() => load(true));
  useCaseEvents(evt => {
    if (evt.event_type === "EApplicationSubmitted" && (!caseId || evt.case_id === caseId)) {
      if (caseId) notify("info", tx("E-Application submitted"), tx("The customer just submitted their e-application."));
      liveRefresh();
    }
  }, true, liveRefresh);
  useEffect(() => { setWorkspace(null); void load(); }, [caseId, root]);
  // Uploaded documents are read by OCR a few seconds later, and only then count towards a requirement.
  // Until every one is read, refresh quietly; then say how each one came out.
  const reading = workspace?.documents.filter((d) => isProcessing(d.status)).map((d) => d.id).join(",") ?? "";
  const pending = useRef(new Map<string, string>());
  useEffect(() => {
    if (!workspace) return;
    for (const d of workspace.documents) {
      if (isProcessing(d.status)) pending.current.set(d.id, d.name);
      else if (pending.current.has(d.id)) {
        pending.current.delete(d.id);
        if (d.status === "Accepted") notify("success", `${tx(d.type)} ${tx("accepted")}`, `${d.name} · ${tx("the requirement list is up to date.")}`);
        else if (d.status === "Processing Failed") notify("error", tx("Document reading interrupted"), tx("Your file is saved. Use Retry reading to try again."));
        else notify("error", `${tx(d.type)} ${tx("couldn't be read")}`, `${d.name} · ${tx("upload a clearer copy.")}`);
      }
    }
  }, [workspace]);
  useEffect(() => {
    if (!caseId || !reading) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await load(true);
      if (!cancelled) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 3000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [caseId, root, reading]);
  const uploadDocument = async (file: File, documentType: string, testCode: string, progress: (value: number) => void) => {
    if (!caseId) throw new Error("No application selected.");
    const form = new FormData(); form.append("document_type", documentType); form.append("file", file);
    if (track === "medical" && testCode) form.append("test_code", testCode);
    await api.post(`/tenants/${user.tenant_id}/cases/${caseId}/underwriting-documents`, form, {
      headers: { "Content-Type": "multipart/form-data" }, timeout: 120000,
      onUploadProgress: event => progress(event.total ? Math.round(event.loaded / event.total * 100) : 0),
    });
  };
  // DEMO ONLY: files an accepted placeholder for each outstanding document so a walkthrough needs no real uploads.
  const markDocumentsUploaded = async (items: { document_type: string; test_code: string }[]) => {
    if (!caseId) return;
    await api.post(`/tenants/${user.tenant_id}/cases/${caseId}/underwriting-documents/demo-complete`, { items });
    void load(true);
  };
  // Waives this track's e-application questionnaire (with a recorded reason) instead of waiting on the customer.
  const waiveEApplication = async () => {
    if (!caseId) return;
    try {
      await api.post(`/tenants/${user.tenant_id}/cases/${caseId}/e-application/${track}/waive`, { reason: "Waived" });
      void load(true);
    } catch (error: any) { notify("error", error?.response?.data?.detail ?? tx("Could not waive.")); }
  };
  // Bulk upload: the server reads each file and names the required test / document type it is.
  const classifyDocuments = async (files: File[]) => {
    if (!caseId) return files.map(() => ({ match: null }));
    const form = new FormData(); files.forEach(file => form.append("files", file));
    const { data } = await api.post<{ results: { index: number; match: string | null; reason?: string | null }[] }>(
      `/tenants/${user.tenant_id}/cases/${caseId}/underwriting-documents/classify`, form,
      { headers: { "Content-Type": "multipart/form-data" }, timeout: 180000 },
    );
    return files.map((_, i) => data.results.find(r => r.index === i) ?? { match: null });
  };
  const openDocument = async (id: string) => {
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try { const url = await getArtifactUrl(id); if (tab) tab.location.href = url; }
    catch { tab?.close(); notify("error", tx("Could not open the document.")); }
  };
  // The report is available once the review is complete: a decision is recorded, or the AI underwriting result is saved.
  const reviewDone = !!workspace && (["CLEARED", "REFERRED", "DECLINED"].includes(workspace.review.status)
    || (track === "medical" && workspace.requirements.some(r => r.key === "medical_ai" && r.status === "Completed"))
    || (track === "financial" && workspace.ai_underwriting != null && (workspace.ai_underwriting as any).result != null));
  const [downloading, setDownloading] = useState(false);
  const downloadReview = async () => {
    if (!workspace || !caseId || !reviewDone) return;
    setDownloading(true);
    try {
      await downloadReviewReport({
        track, reference: workspace.reference, customerName: workspace.customer_name, customerCnic: workspace.customer_cnic,
        productName: workspace.product_name, coverageAmount: workspace.coverage_amount, termYears: workspace.term_years,
        reviewStatus: workspace.review.status, reviewer: workspace.review.assigned_user_name, decidedAt: workspace.review.updated_at,
        note: workspace.review.note, evidence: workspace.evidence, assessment: workspace.assessment ? { score: workspace.assessment.score, reasons: workspace.assessment.reasons } : null,
        documents: workspace.documents.map(d => ({ name: d.name, type: d.type, status: d.status })),
      }, caseId);
    } catch { notify("error", tx("Could not create the report.")); }
    finally { setDownloading(false); }
  };
  const sendEApplication = async () => {
    if (!caseId) return;
    setSaving(true);
    try {
      const result = await inviteEApplicationPart(caseId, track);
      if (result.email_status === "sent") notify("success", tx(track === "medical" ? "Medical e-application sent" : "Financial e-application sent"), `${tx("Emailed to")} ${result.emailed_to}.`);
      else notify("error", tx("E-Application not emailed"), tx(result.email_status === "no_email" ? "No customer email is recorded. Add their email before sending." : "The link was created but the email failed. Please retry."));
      await load(true);
    } catch (err: any) { notify("error", tx("Could not send the e-application."), err?.response?.data?.detail); }
    finally { setSaving(false); }
  };
  const startReview = async () => {
    if (!caseId || !user.tenant_id) return;
    setSaving(true);
    try { await updateUnderwritingTrack(user.tenant_id, caseId, track, { assigned_user_id: user.id }); await load(true); notify("success", tx("Review started"), tx("This application is now on your desk.")); }
    catch (err: any) { notify("error", tx("Could not start this review."), err?.response?.data?.detail); }
    finally { setSaving(false); }
  };
  const save = async () => {
    if (!caseId || !user.tenant_id || !workspace || workspace.read_only) return;
    setSaving(true);
    try {
      const review = await updateUnderwritingTrack(user.tenant_id, caseId, track, { status: decision, note });
      setWorkspace({ ...workspace, review });
      notify("success", `${tx(track === "medical" ? "Medical review" : "Financial review")}: ${tx(LABELS[review.status])}`, tx("Saved. Final application approval is a separate step."));
    } catch (err: any) { notify("error", tx("Could not save the review."), err?.response?.data?.detail); }
    finally { setSaving(false); }
  };
  // The server lists only the reviews assigned to this specialist.
  const scoped = rows.filter((r) => `${r.customer_name} ${r.reference} ${r.product_name ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()));
  // Applications that went on to approval, closure or rejection stay as a read-only record, after the open ones.
  const filtered = scoped.filter((r) => filter === "ALL" || (filter === "CLOSED" ? r.closed : r.review.status === filter || (filter === "DECIDED" && ["CLEARED", "REFERRED", "DECLINED"].includes(r.review.status))))
    .sort((a, b) => Number(Boolean(a.closed)) - Number(Boolean(b.closed)));
  const filteredFirst = floatNew(filtered, (r) => r.id, arrivals.newIds);   // the case that just arrived sits at the top
  const { pageItems, pagination } = usePagination(filteredFirst, 12, `${filter}:${search}`);
  const revealNew = useRevealNew({ filtered: filteredFirst, keyOf: (r: ReviewRow) => r.id, newIds: arrivals.newIds, pageSize: 12, setPage: pagination.setPage, reset: () => { setFilter("ALL"); setSearch(""); } });
  return <div className={caseId ? "case-modern mx-auto max-w-screen-2xl space-y-5 px-6 pb-10" : "mx-auto max-w-screen-2xl space-y-5 px-4 py-6 sm:px-6"}>
    {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</p>}
    <Toaster />
    {loading ? <div role="status" className="py-20 text-center text-sm text-slate-500">{tx("Loading reviews…")}</div> : caseId ? workspace && <>
      <CaseWorkspaceHeader name={workspace.customer_name} reference={workspace.reference} backLabel={label}
        status={<ApplicationStatus outstanding={workspace.application_outstanding} onOpen={() => setCaseTab("requirements")} />}
        extraStatus={<span className="text-xs font-semibold text-blue-600">{tx(label)}</span>}
        fields={[{ label: "CNIC", value: workspace.customer_cnic }, { label: "Plan", value: workspace.product_name }, { label: "Cover", value: workspace.coverage_amount != null ? fmtCoverage(workspace.coverage_amount) : null }, { label: "Term", value: workspace.term_years ? `${workspace.term_years} ${tx("yrs")}` : null }, { label: "Opened", value: displayDate(workspace.created_at) }]}
        tab={caseTab} onTab={setCaseTab} documentCount={workspace.documents.length}
        actions={<div className="flex items-center gap-2"><button onClick={() => setCaseTab("documents")} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700">{tx(track === "medical" ? "Upload reports" : "Documents")} · {workspace.documents.length}</button><button onClick={() => void downloadReview()} disabled={!reviewDone || downloading} title={reviewDone ? undefined : tx("Available once the underwriting review is completed")} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-40">{downloading ? tx("Preparing…") : tx("Download")}</button><button onClick={() => void load()} disabled={loading || saving} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700">{tx("Refresh")}</button><Badge status={workspace.review.status} /></div>}
      />
      {workspace.on_hold && <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{tx("Application on hold")}: {workspace.hold_reason}. {tx("Review changes are disabled until the hold is released.")}</p>}
      {workspace.read_only && !workspace.on_hold && <p className="rounded-xl bg-slate-100 p-4 text-sm text-slate-700">{tx("This application is closed for specialist review.")}</p>}
      {!workspace.review.assigned_user_id && !workspace.read_only && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4"><p className="text-sm text-blue-900">{tx("Start your review to use the underwriting tools for this application.")}</p><button className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40" disabled={saving} onClick={() => void startReview()}>{tx("Start my review")}</button></div>}
      {!workspace.policy_linked && <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{tx("No proposal is linked to this application. An admin must link the correct proposal before medical requirements or financial exposure can be assessed.")}</p>}

      <div className={caseTab === "overview" ? "grid items-start gap-5 xl:grid-cols-12" : "hidden"}>
        <div className="min-w-0 space-y-5 xl:col-span-8">
          {/* A claim review is checked against the claim's plan terms (Requirements tab) — not run like a new
              application: no exam ordered from the non-medical grid, no exposure check, AI rating or e-application. */}
          {workspace.claim && <ClaimReviewChecks requirements={workspace.requirements} checks={workspace.claim_checks ?? {}}
            disabled={workspace.read_only || workspace.review.assigned_user_id !== user.id}
            onEvidence={setCaseTab} onSave={async (key, finding, rationale) => {
              await api.put(`/tenants/${user.tenant_id}/cases/${caseId}/underwriting-tracks/${track}`, {
                claim_checks: [{key, finding, note: rationale}],
              });
              await load(true);
              notify("success", tx("Finding saved"));
            }} />}
          {!workspace.claim && <>
          <TrackOperations key={caseId} track={track} caseId={caseId} documentsVersion={workspace.documents.map((d) => `${d.id}:${d.status}`).join(",")} disabled={workspace.read_only || workspace.review.assigned_user_id !== user.id || !workspace.policy_linked} onChanged={() => { void load(true); }} />
          {track === "financial" && <FinancialAIPanel tenantId={user.tenant_id!} caseId={caseId} ai={workspace.ai_underwriting}
            disabled={workspace.read_only || workspace.review.assigned_user_id !== user.id || !workspace.policy_linked} onDone={() => { void load(true); }} />}
          <EApplicationPanel caseId={caseId} track={track} refreshKey={workspace.requirements.find((r) => r.key === "e_application")?.status}
            onSend={() => void sendEApplication()} sending={saving} canSend={!workspace.read_only && workspace.review.assigned_user_id === user.id} onViewAnswers={() => setCaseTab("applicant")}
            onWaive={() => void waiveEApplication()} waived={workspace.requirements.find((r) => r.key === "e_application")?.status === "Waived"} />
          </>}
        </div>
        <aside className="space-y-5 xl:col-span-4">
          {workspace.claim && <ClaimUnderwritingSummary claim={workspace.claim} />}
          <ReviewPanel key={workspace.review.updated_at ?? "new"} track={track} workspace={workspace} decision={decision} setDecision={setDecision} note={note} setNote={setNote} saving={saving} onSave={() => void save()} />
          <RequirementChecklist requirements={workspace.requirements} onOpen={setCaseTab} />
          <RiskEvidence assessment={workspace.assessment} />
        </aside>
      </div>
      <div className={caseTab === "requirements" ? "space-y-5" : "hidden"}>
        <RequirementsBoard track={track} requirements={workspace.requirements} requiredDocuments={workspace.required_documents} outstanding={workspace.application_outstanding} onOpen={setCaseTab}
          onSendEApplication={workspace.read_only || workspace.review.assigned_user_id !== user.id ? undefined : () => void sendEApplication()} sending={saving}
          onWaiveEApplication={workspace.read_only || workspace.review.assigned_user_id !== user.id ? undefined : () => void waiveEApplication()} />
      </div>
      <div className={caseTab === "documents" ? "space-y-5" : "hidden"}>
        <ReviewDocuments key={caseId} medical={track === "medical"} documents={workspace.documents}
          tests={Array.isArray(workspace.evidence["Required tests"]) ? workspace.evidence["Required tests"] as {code: string; name: string}[] : []}
          requiredDocuments={track === "financial" ? workspace.required_documents : []}
          applicationDocuments={workspace.claim
            // A claim review's documents are the claim's, from its plan's claim terms: one card each for this track.
            ? workspace.required_documents.filter(d => !d.received).map(d => ({ type: d.type, reason: tx("Required for this claim by the plan."), canUpload: true, owner: null, tag: "Claim" }))
            : workspace.application_outstanding.filter(o => o.can_upload).map(o => ({ type: o.document_type!, reason: o.reason, canUpload: o.can_upload, owner: o.owner }))}
          disabled={workspace.read_only || workspace.review.assigned_user_id !== user.id}
          onRetry={async id => {
            await api.post(`/tenants/${user.tenant_id}/cases/${caseId}/underwriting-documents/${id}/retry`);
            await load(true);
          }}
          onUploadFile={uploadDocument} onMarkAllUploaded={markDocumentsUploaded} onClassify={classifyDocuments} onUploaded={() => { void load(true); }} onOpen={id => { void openDocument(id); }} />
      </div>
      <div className={caseTab === "applicant" ? "" : "hidden"}>
        <ApplicantPolicyTab track={track} evidence={workspace.evidence} customerName={workspace.customer_name} cnic={workspace.customer_cnic}
          productName={workspace.product_name} coverage={workspace.coverage_amount} termYears={workspace.term_years} openedAt={workspace.created_at} />
      </div>
    </> : <>
      <NewArrivalsBanner count={arrivals.newIds.size} noun="case" onShow={revealNew} onDismiss={arrivals.markAllSeen} />
      <QueueHeader track={track} label={label} rows={rows} loading={saving} onRefresh={() => void load(true)} onPick={setFilter} />
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <label className="relative min-w-56 flex-1"><span className="sr-only">{tx("Search applications")}</span><svg className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg><input placeholder={tx("Search applicant, application or product…")} value={search} onChange={(e) => setSearch(e.target.value)} className="w-full rounded-xl border border-slate-200 bg-white py-2 pe-3 ps-9 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100" /></label>
        </div>
        <div className="flex flex-wrap gap-1.5 border-b border-slate-100 px-4 py-3">{["ALL", ...Object.keys(LABELS), "CLOSED"].map((key) => { const count = scoped.filter((r) => key === "ALL" || (key === "CLOSED" ? r.closed : r.review.status === key)).length; return <button key={key} onClick={() => setFilter(key)} aria-pressed={filter === key} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition ${filter === key ? "bg-slate-900 text-white" : count ? "text-slate-600 hover:bg-slate-100" : "text-slate-400 hover:bg-slate-50"}`}>{tx(key === "ALL" ? "All statuses" : key === "CLOSED" ? "Closed applications" : LABELS[key as UnderwritingReviewStatus])}<span className={`rounded-full px-1.5 text-[11px] ${filter === key ? "bg-white/20" : "bg-slate-100"}`}>{count}</span></button>; })}</div>
        {filtered.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wide text-slate-500"><tr>{["Applicant", "Plan & cover", "Opened", "Your review", ""].map((h, i) => <th key={i} className="whitespace-nowrap px-5 py-2.5">{h && tx(h)}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100">{pageItems.map((row) => { const days = row.created_at ? Math.max(0, Math.floor((Date.now() - new Date(row.created_at).getTime()) / 86400000)) : null; return <tr key={row.id} className={`group cursor-pointer transition hover:bg-blue-50/40 ${row.closed ? "bg-slate-50/50" : ""}`} onClick={() => router.push(`/case/${row.id}`)}>
            <td className="px-5 py-3.5"><div className="flex items-center gap-3"><span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 text-xs font-bold text-white">{initials(row.customer_name)}</span><div className="min-w-0"><p className="truncate font-semibold text-slate-900">{row.customer_name}</p><p className="font-mono text-[11px] text-slate-400">{row.claim_id && <span className="me-1.5 rounded-md border border-blue-200 bg-blue-50 px-1.5 py-0.5 font-sans text-[10px] font-bold uppercase text-blue-700">{tx("Claim UW")}</span>}{row.reference.replace(/^CASE-/, "APP-")}</p></div>{row.closed && <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${row.case_status === "Approved" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : row.case_status === "Rejected" ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-slate-100 text-slate-600 ring-slate-200"}`}>{tx(row.case_status === "Approved" ? "Application approved" : row.case_status === "Rejected" ? "Application rejected" : "Application closed")}</span>}{row.on_hold && <span title={row.hold_reason ?? undefined} className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-200">{tx("On hold")}</span>}</div></td>
            <td className="px-5 py-3.5"><p className="text-slate-800">{row.product_name ?? <span className="text-slate-400">{tx("No plan linked")}</span>}</p>{row.coverage_amount != null && <p className="text-xs text-slate-500">{fmtCoverage(row.coverage_amount)}</p>}</td>
            <td className="whitespace-nowrap px-5 py-3.5"><p className="text-slate-700">{row.created_at ? displayDate(row.created_at) : "—"}</p>{days != null && <p className={`text-xs ${days > 7 ? "text-amber-700" : "text-slate-400"}`}>{days === 0 ? tx("Today") : `${days} ${tx(days === 1 ? "day ago" : "days ago")}`}</p>}</td>
            <td className="px-5 py-3.5"><Badge status={row.review.status} /></td>
            <td className="px-5 py-3.5 text-end"><Link onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold text-blue-700 transition group-hover:bg-blue-600 group-hover:text-white" href={`/case/${row.id}`}>{tx(row.closed ? "View record" : "Open review")} →</Link></td>
          </tr>; })}</tbody></table></div>
        : <div className="px-5 py-16 text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400"><svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H5v18h14V8Z" /><path d="M14 3v6h5" /></svg></div><p className="mt-3 text-sm font-semibold text-slate-800">{tx(search || filter !== "ALL" ? "No reviews match these filters" : "Nothing assigned to you right now")}</p><p className="mt-1 text-sm text-slate-500">{tx(search || filter !== "ALL" ? "Try another status or search." : "Applications appear here when an admin assigns them to you.")}</p></div>}
        <Pagination pagination={pagination} noun={tx("reviews")} inline />
      </section>
    </>}
  </div>;
}

const DECISION_TONE: Record<Exclude<UnderwritingReviewStatus, "PENDING">, string> = {
  IN_REVIEW: "border-blue-500 bg-blue-50 text-blue-700", CLEARED: "border-emerald-500 bg-emerald-50 text-emerald-700",
  REFERRED: "border-amber-500 bg-amber-50 text-amber-800", DECLINED: "border-rose-500 bg-rose-50 text-rose-700",
};
function StateIcon({ state, index }: { state: RequirementState; index?: number }) {
  return <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold ${STATE_TONE[state].icon}`}>
    {state === "done" ? <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
      : state === "blocked" ? "!" : state === "attention" ? "!" : index ?? ""}
  </span>;
}
function StatusPill({ status }: { status: string }) {
  const tone = STATE_TONE[requirementState(status)];
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${tone.pill}`}><span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />{tx(statusLabel(status))}</span>;
}

const FINAL: UnderwritingReviewStatus[] = ["CLEARED", "REFERRED", "DECLINED"];
const OUTCOME: Record<string, { card: string; icon: string; path: string; verb: string }> = {
  CLEARED: { card: "border-emerald-200 bg-emerald-50/60", icon: "bg-emerald-500", path: "m5 12 4 4L19 6", verb: "You cleared this application" },
  REFERRED: { card: "border-amber-200 bg-amber-50/60", icon: "bg-amber-500", path: "M5 12h14m-5-5 5 5-5 5", verb: "You referred this application" },
  DECLINED: { card: "border-rose-200 bg-rose-50/60", icon: "bg-rose-500", path: "M7 7l10 10M17 7 7 17", verb: "You declined this application" },
};

function ReviewPanel({ track, workspace, decision, setDecision, note, setNote, saving, onSave }: {
  track: "medical" | "financial"; workspace: Workspace; decision: UnderwritingReviewStatus; setDecision: (d: UnderwritingReviewStatus) => void;
  note: string; setNote: (n: string) => void; saving: boolean; onSave: () => void;
}) {
  const saved = workspace.review;
  // A recorded decision reads as an outcome, not as a form still waiting to be submitted.
  const [editing, setEditing] = useState(!FINAL.includes(saved.status));
  const locked = workspace.read_only || saving;
  const needsNote = FINAL.includes(decision) && !note.trim();
  // Cleared is only possible once every requirement of this review is met (referring or declining can come earlier).
  const DONE = ["Submitted", "Verified", "Clear", "Completed", "NotRequired", "Waived", "Received"];
  const unmet = workspace.requirements.filter((r) => !DONE.includes(r.status));
  const canClear = unmet.length === 0;
  const unchanged = decision === saved.status && note === (saved.note ?? "");
  if (!editing && OUTCOME[saved.status]) {
    const o = OUTCOME[saved.status];
    return <section className={`rounded-2xl border p-5 shadow-sm ${o.card}`}>
      <div className="flex items-start gap-3"><span className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-white ${o.icon}`}><svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={o.path} /></svg></span>
        <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tx(track === "medical" ? "Medical review" : "Financial review")}</p><h2 className="text-lg font-bold text-slate-900">{tx(LABELS[saved.status])}</h2><p className="text-xs text-slate-600">{tx(o.verb)}{saved.updated_at ? ` · ${new Date(saved.updated_at).toLocaleString()}` : ""}</p></div></div>
      {saved.note && <blockquote className="mt-4 whitespace-pre-wrap rounded-xl bg-white/80 p-3 text-sm text-slate-700 ring-1 ring-inset ring-slate-200">{saved.note}</blockquote>}
      <p className="mt-3 text-xs text-slate-500">{tx("Recorded for the underwriting decision. Final approval and policy issue happen separately.")}</p>
      {!workspace.read_only && <button onClick={() => setEditing(true)} className="mt-4 w-full rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-slate-300">{tx("Change decision")}</button>}
    </section>;
  }
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
    <div className="flex items-start justify-between gap-3"><div><h2 className="text-base font-semibold text-slate-900">{tx("Your review")}</h2><p className="mt-0.5 text-xs text-slate-500">{tx("Specialist review only — it does not approve or issue the policy.")}</p></div><Badge status={saved.status} /></div>
    <fieldset className="mt-4" disabled={locked}><legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tx("Review status")}</legend>
      <div className="mt-2 grid grid-cols-2 gap-2">{(Object.keys(DECISION_TONE) as (keyof typeof DECISION_TONE)[]).map((key) => <button key={key} type="button" aria-pressed={decision === key} disabled={key === "CLEARED" && !canClear} title={key === "CLEARED" && !canClear ? tx("Complete every requirement first") : undefined} onClick={() => setDecision(key)}
        className={`rounded-xl border px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${decision === key ? DECISION_TONE[key] : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}>{tx(LABELS[key])}</button>)}</div>
    </fieldset>
    {!canClear && <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{tx("Cleared unlocks once every requirement is complete. Still open:")} {unmet.map((r) => tx(r.label)).join(", ")}.</p>}
    <label className="mt-4 block"><span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tx("Notes and rationale")}</span>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} maxLength={2000} disabled={locked} placeholder={tx("Summarise the evidence behind your decision…")} className="mt-2 w-full resize-y rounded-xl border border-slate-200 p-3 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100" />
    </label>
    <div className="mt-1 flex justify-between text-[11px] text-slate-400"><span>{needsNote ? tx("A rationale is required for this decision.") : saved.updated_at ? `${tx("Last saved")} ${new Date(saved.updated_at).toLocaleString()}` : ""}</span><span>{note.length}/2000</span></div>
    <div className="mt-3 flex gap-2">
      {FINAL.includes(saved.status) && <button onClick={() => { setDecision(saved.status); setNote(saved.note ?? ""); setEditing(false); }} disabled={saving} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600">{tx("Cancel")}</button>}
      <button onClick={onSave} disabled={locked || needsNote || unchanged || (decision === "CLEARED" && !canClear)} className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40">{tx(saving ? "Saving…" : FINAL.includes(decision) ? `Record: ${LABELS[decision]}` : "Save review")}</button>
    </div>
  </section>;
}

// The application-level requirement codes, in words the underwriter recognises.
const APPLICATION_REQUIREMENTS: Record<string, string> = {
  CNIC: "CNIC copy", SALARY_SLIP: "Salary slip", BANK_STATEMENT: "Bank statement", TAX_DOCUMENT: "Tax document",
  MEDICAL_QUESTIONNAIRE: "Customer e-application", MEDICAL_EXAMINATION: "Medical examination", ECG: "ECG",
  LAB_REPORTS: "Lab reports", PHYSICIAN_REPORT: "Physician report", ADDITIONAL_DOCUMENT: "Additional document",
};
/** Only what this specialist can act on: application documents their track still has to collect. The
 * application's own status (Pending documents, Under review…) belongs to pre-underwriting and stays off this screen. */
function ApplicationStatus({ outstanding, onOpen }: { outstanding: Outstanding[]; onOpen: () => void }) {
  const mine = outstanding.filter((o) => o.can_upload);
  if (!mine.length) return null;
  return <button type="button" onClick={onOpen} title={`${tx("Needed for the application")}: ${mine.map((o) => tx(APPLICATION_REQUIREMENTS[o.code] ?? o.code)).join(", ")}`}
    className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 hover:border-amber-300">
    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />{mine.length} {tx(mine.length === 1 ? "document needed from you" : "documents needed from you")}
  </button>;
}

function RequirementChecklist({ requirements, onOpen }: { requirements: Requirement[]; onOpen: (tab: CaseTab) => void }) {
  const done = requirements.filter((r) => requirementState(r.status) === "done").length;
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
    <div className="flex items-center justify-between"><h2 className="text-base font-semibold text-slate-900">{tx("Requirements")}</h2><span className="text-xs font-semibold text-slate-500">{done}/{requirements.length} {tx("complete")}</span></div>
    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${requirements.length ? done / requirements.length * 100 : 0}%` }} /></div>
    <ul className="mt-3 -mx-2">{requirements.map((r, i) => <li key={r.key ?? r.label}><button type="button" onClick={() => { onOpen(r.section); if (r.key.startsWith("claim_")) requestAnimationFrame(() => document.getElementById(r.key)?.scrollIntoView({behavior:"smooth",block:"start"})); }} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-slate-50">
      <StateIcon state={requirementState(r.status)} index={i + 1} />
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-slate-800">{tx(r.label)}</span><span className="block text-xs text-slate-500">{tx(r.detail ?? statusLabel(r.status))}</span></span>
    </button></li>)}</ul>
  </section>;
}

function RiskEvidence({ assessment }: { assessment: Workspace["assessment"] }) {
  const score = assessment?.score;
  const [tone, bar] = score == null ? ["text-slate-400", "bg-slate-300"] : score >= 70 ? ["text-rose-600", "bg-rose-500"] : score >= 40 ? ["text-amber-600", "bg-amber-500"] : ["text-emerald-600", "bg-emerald-500"];
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
    <h2 className="text-base font-semibold text-slate-900">{tx("AI risk evidence")}</h2>
    {assessment ? <>
      <div className="mt-3 flex items-baseline gap-1"><span className={`text-3xl font-bold tabular-nums ${tone}`}>{score}</span><span className="text-sm text-slate-400">/ 100</span></div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.min(100, Math.max(0, score ?? 0))}%` }} /></div>
      {Array.isArray(assessment.reasons) && assessment.reasons.length > 0 && <ul className="mt-3 space-y-1.5 text-sm text-slate-600">{assessment.reasons.map((r, i) => <li key={i} className="flex gap-2"><span className="mt-2 h-1 w-1 flex-shrink-0 rounded-full bg-slate-400" />{valueText(r)}</li>)}</ul>}
      <details className="mt-3 text-xs text-slate-500"><summary className="cursor-pointer font-medium">{tx("Model output")}</summary><p className="mt-2 whitespace-pre-wrap break-words">{valueText(assessment.results)}</p></details>
      <p className="mt-3 text-[11px] text-slate-400">{tx("Assessed")} {new Date(assessment.created_at).toLocaleString()}</p>
    </> : <p className="mt-2 text-sm text-slate-500">{tx("No current assessment. Missing evidence is not clearance.")}</p>}
  </section>;
}

// The e-application can be (re)sent until the customer submits it; a new link replaces the old one.
const SENDABLE = new Set(["NotSent", "Sent", "InProgress", "Expired"]);
function RequirementsBoard({ track, requirements, requiredDocuments, outstanding, onOpen, onSendEApplication, onWaiveEApplication, sending }: {
  track: "medical" | "financial"; requirements: Requirement[]; requiredDocuments: RequiredDocument[]; outstanding: Outstanding[]; onOpen: (tab: CaseTab) => void;
  /** Absent when this specialist can't act on the application (not theirs, held or closed). */
  onSendEApplication?: () => void; onWaiveEApplication?: () => void; sending: boolean;
}) {
  const done = requirements.filter((r) => requirementState(r.status) === "done").length;
  return <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-100 px-5 py-4">
      <div><h2 className="text-base font-semibold text-slate-900">{tx(track === "medical" ? "Medical underwriting requirements" : "Financial underwriting requirements")}</h2><p className="mt-0.5 text-sm text-slate-500">{tx("What this review needs. Other underwriting responsibilities stay with their assigned roles.")}</p></div>
      <div className="w-48"><div className="flex justify-between text-xs font-semibold text-slate-500"><span>{tx("Progress")}</span><span>{done}/{requirements.length}</span></div><div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${requirements.length ? done / requirements.length * 100 : 0}%` }} /></div></div>
    </header>
    <ol className="divide-y divide-slate-100">{requirements.map((r, i) => { const state = requirementState(r.status); return <li key={r.key ?? r.label} className="flex flex-wrap items-center gap-4 px-5 py-4">
      <StateIcon state={state} index={i + 1} />
      <div className="min-w-0 flex-1"><h3 className={`text-sm font-semibold ${state === "done" ? "text-slate-500" : "text-slate-900"}`}>{tx(r.label)}</h3>
        {r.key === "application_documents" ? <div className="mt-1.5 flex flex-wrap gap-1.5">{outstanding.filter((o) => o.can_upload).map((o) => <span key={o.code} title={o.reason} className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-100">○ {tx(o.document_type!)}</span>)}</div>
          : r.key === "documents" ? <div className="mt-1.5 flex flex-wrap gap-1.5">{requiredDocuments.map((d) => <span key={d.type} className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${d.received ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{d.received ? "✓" : "○"} {d.type}</span>)}</div>
          : r.detail && <p className="mt-0.5 text-xs text-slate-500">{tx(r.detail)}</p>}
      </div>
      <StatusPill status={r.status} />
      {r.key === "e_application" && SENDABLE.has(r.status) && <button disabled={!onSendEApplication || sending} onClick={onSendEApplication} title={onSendEApplication ? undefined : tx("Start your review to email the customer.")} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-40"><svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16v12H4z" /><path d="m4 7 8 6 8-6" /></svg>{tx(sending ? "Sending…" : r.status === "NotSent" ? "Email to customer" : "Resend email")}</button>}
      {r.key === "e_application" && SENDABLE.has(r.status) && <button disabled={!onWaiveEApplication || sending} onClick={onWaiveEApplication} className="inline-flex items-center rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">{tx("Waive")}</button>}
      <button onClick={() => { onOpen(r.section); if (r.key.startsWith("claim_")) requestAnimationFrame(() => document.getElementById(r.key)?.scrollIntoView({behavior:"smooth",block:"start"})); if (r.key === "medical_ai") requestAnimationFrame(() => document.getElementById("medical-underwriting")?.scrollIntoView({behavior:"smooth",block:"start"})); }} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${state === "done" ? "text-slate-500 hover:bg-slate-50" : "border border-slate-200 text-blue-700 hover:border-blue-300"}`}>{tx(state === "done" ? "View" : r.key === "medical_ai" ? "Run AI medical underwriting" : r.key === "documents" || r.key === "application_documents" ? "Upload" : "Open")} →</button>
    </li>; })}</ol>
  </section>;
}

const initials = (name: string) => name.split(" ").map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();

function QueueHeader({ track, label, rows, loading, onRefresh, onPick }: {
  track: "medical" | "financial"; label: string; rows: ReviewRow[]; loading: boolean;
  onRefresh: () => void; onPick: (filter: string) => void;
}) {
  const open = rows.filter((r) => !r.closed);
  const count = (...statuses: UnderwritingReviewStatus[]) => open.filter((r) => statuses.includes(r.review.status)).length;
  const stats: { label: string; value: number; hint: string; tone: string; pick: string }[] = [
    { label: "Open on your desk", value: open.length, hint: "Assigned to you and still in progress", tone: "text-slate-900", pick: "ALL" },
    { label: "Not started", value: count("PENDING"), hint: "Waiting for you to begin", tone: "text-slate-900", pick: "PENDING" },
    { label: "In review", value: count("IN_REVIEW"), hint: "Awaiting your decision", tone: "text-blue-700", pick: "IN_REVIEW" },
    { label: "Closed applications", value: rows.length - open.length, hint: "Approved, closed or rejected — kept as your record", tone: "text-emerald-700", pick: "CLOSED" },
  ];
  return <>
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="text-xs font-semibold uppercase tracking-widest text-blue-600">{tx("Specialist review")}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">{tx(label)}</h1>
        <p className="mt-1 text-sm text-slate-500">{tx(track === "medical" ? "Health declarations, medical evidence and medical risk for your applications." : "Declared income, existing cover and financial risk for your applications.")}</p></div>
      <button onClick={onRefresh} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-sm hover:border-slate-300 disabled:opacity-50"><svg className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>{tx("Refresh")}</button>
    </header>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{stats.map((s) => <button key={s.label} type="button" onClick={() => onPick(s.pick)} className="rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-blue-200 hover:shadow">
      <p className="text-xs font-medium text-slate-500">{tx(s.label)}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${s.tone}`}>{s.value}</p>
      <p className="mt-0.5 text-[11px] text-slate-400">{tx(s.hint)}</p>
    </button>)}</div>
  </>;
}
