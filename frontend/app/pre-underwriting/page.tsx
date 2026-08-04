"use client";

// Pre-Underwriting — Intake & Compliance Checks.
// Dedicated queue for the three gates that must clear before a case moves
// into AI/underwriter risk assessment: the Initial Premium Payment (Section
// 30, "no premium, no risk" — collected at proposal submission per Adamjee's
// actual process, before underwriting begins), the customer's E-Application
// (medical questionnaire, family history, declaration), and the agent's
// Confidential Report (ACR). Mirrors the Pre/Post Policy Issuance pages'
// pattern of giving each lifecycle stage its own top-level view, rather than
// burying this only inside /case/[id].

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MetricCard } from "@/components/MetricCard";
import { listCases, type CaseQueueItem } from "@/app/services/cases";
import { inviteEApplication } from "@/app/services/eApplication";
import { getACR, type AgentConfidentialReport } from "@/app/services/agentConfidentialReport";
import { ACRModal } from "@/components/entities/ACRModal";
import { IPPModal } from "@/components/entities/IPPModal";

const ACTIVE_STATUSES = new Set(["New", "InProgress", "Pending Documents", "Under Review"]);

function StatusPill({ done, pending, label }: { done: boolean; pending: string; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${
        done ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-amber-50 text-amber-700 border-amber-200"
      }`}
    >
      {done ? "✓" : "!"} {done ? label : pending}
    </span>
  );
}

export default function PreUnderwritingPage() {
  const router = useRouter();
  const [cases, setCases] = useState<CaseQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const [userRole, setUserRole] = useState<string | null>(null);

  const [linkBusyFor, setLinkBusyFor] = useState<string | null>(null);
  const [generatedLinks, setGeneratedLinks] = useState<Record<string, string>>({});
  const [linkErr, setLinkErr] = useState<string | null>(null);

  const [acrModal, setAcrModal] = useState<{ caseId: string; initial: AgentConfidentialReport | null } | null>(null);
  const [acrLoadingFor, setAcrLoadingFor] = useState<string | null>(null);

  const [ippModal, setIppModal] = useState<{ caseId: string; customerName?: string } | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") setUserRole(localStorage.getItem("user_role"));
  }, []);

  const tenantId = typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const data = await listCases(tenantId);
      setCases(data);
    } catch {
      // non-fatal — empty state renders below
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { load(); }, [load]);

  const isFullyReady = (c: CaseQueueItem) =>
    c.ipp_status === "Realized" && c.e_application_status === "Submitted" && c.acr_status === "Submitted";

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cases
      .filter((c) => ACTIVE_STATUSES.has(c.caseStatus))
      .filter((c) => showCompleted || !isFullyReady(c))
      .filter((c) =>
        !q ||
        (c.customer_name ?? "").toLowerCase().includes(q) ||
        (c.customer_cnic ?? "").toLowerCase().includes(q) ||
        c.caseNumber.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const aDone = isFullyReady(a);
        const bDone = isFullyReady(b);
        if (aDone !== bDone) return aDone ? 1 : -1;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }, [cases, search, showCompleted]);

  const kpis = useMemo(() => {
    const active = cases.filter((c) => ACTIVE_STATUSES.has(c.caseStatus));
    const missingIpp = active.filter((c) => c.ipp_status !== "Realized").length;
    const missingEApp = active.filter((c) => c.e_application_status !== "Submitted").length;
    const missingAcr = active.filter((c) => c.acr_status !== "Submitted").length;
    const ready = active.filter(isFullyReady).length;
    return { total: active.length, missingIpp, missingEApp, missingAcr, ready };
  }, [cases]);

  const handleGenerateLink = async (c: CaseQueueItem) => {
    setLinkBusyFor(c.caseld); setLinkErr(null);
    try {
      const invite = await inviteEApplication(c.caseld);
      setGeneratedLinks((prev) => ({ ...prev, [c.caseld]: `${window.location.origin}${invite.link_path}` }));
      await load();
    } catch (e: any) {
      setLinkErr(e?.message ?? "Failed to generate link");
    } finally {
      setLinkBusyFor(null);
    }
  };

  const openAcrModal = async (c: CaseQueueItem) => {
    setAcrLoadingFor(c.caseld);
    try {
      const acr = await getACR(c.caseld);
      setAcrModal({ caseId: c.caseld, initial: acr.status === "NotStarted" ? null : acr });
    } catch {
      setAcrModal({ caseId: c.caseld, initial: null });
    } finally {
      setAcrLoadingFor(null);
    }
  };

  const canFileAcr = userRole === "Agent" || userRole === "Admin";

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Pre-Underwriting</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Intake &amp; compliance — the initial premium payment, the customer's E-Application, and the agent's
          Confidential Report must all clear here before a case is ready for AI/underwriter risk assessment.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <MetricCard title="Active Cases" value={kpis.total} subtitle="pre-decision" accent="slate" />
        <MetricCard title="Missing IPP" value={kpis.missingIpp} subtitle="premium not paid" accent="amber" />
        <MetricCard title="Missing E-Application" value={kpis.missingEApp} subtitle="not yet submitted" accent="amber" />
        <MetricCard title="Missing ACR" value={kpis.missingAcr} subtitle="not yet filed" accent="amber" />
        <MetricCard title="Fully Ready" value={kpis.ready} subtitle="all three cleared" accent="blue" />
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <input
          type="text"
          placeholder="Search by customer, CNIC, or case number…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-xs px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
        />
        <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
          <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} />
          Show fully-submitted cases
        </label>
      </div>

      {linkErr && <p className="text-xs text-red-600">{linkErr}</p>}

      <div className="card overflow-hidden">
        {loading ? (
          <p className="text-sm text-slate-400 p-6">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-slate-400 p-6">No cases need attention right now.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
              <tr>
                <th className="px-5 py-3 text-left">Case</th>
                <th className="px-5 py-3 text-left">Case Status</th>
                <th className="px-5 py-3 text-left">Initial Premium Payment</th>
                <th className="px-5 py-3 text-left">E-Application</th>
                <th className="px-5 py-3 text-left">Agent's Confidential Report</th>
                <th className="px-5 py-3 text-left" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filtered.map((c) => (
                <tr key={c.caseld} className="hover:bg-slate-50">
                  <td className="px-5 py-3">
                    <p className="text-xs font-semibold text-slate-900">{c.customer_name}</p>
                    <p className="font-mono text-[10px] text-slate-500 mt-0.5">{c.caseNumber}</p>
                  </td>
                  <td className="px-5 py-3">
                    <span className="inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-slate-100 text-slate-600 border-slate-200">
                      {c.caseStatus}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-col gap-1.5 items-start">
                      <StatusPill done={c.ipp_status === "Realized"} pending={c.ipp_status ?? "Not Started"} label="Paid" />
                      {c.ipp_status !== "Realized" && (
                        <button
                          onClick={() => setIppModal({ caseId: c.caseld, customerName: c.customer_name ?? undefined })}
                          className="text-[11px] font-semibold text-blue-600 hover:text-blue-700"
                        >
                          {c.ipp_status === "Initiated" ? "Complete Payment" : "Collect Payment"}
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-col gap-1.5 items-start">
                      <StatusPill done={c.e_application_status === "Submitted"} pending={c.e_application_status ?? "Not Sent"} label="Submitted" />
                      <button
                        onClick={() => handleGenerateLink(c)}
                        disabled={linkBusyFor === c.caseld}
                        className="text-[11px] font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-40"
                      >
                        {linkBusyFor === c.caseld ? "Generating…" : c.e_application_status && c.e_application_status !== "NotSent" ? "Resend Link" : "Generate Link"}
                      </button>
                      {generatedLinks[c.caseld] && (
                        <div className="flex items-center gap-1.5">
                          <input readOnly value={generatedLinks[c.caseld]} onFocus={(e) => e.currentTarget.select()}
                            className="text-[10px] border border-slate-200 rounded px-1.5 py-1 w-40 text-slate-500" />
                          <button onClick={() => navigator.clipboard.writeText(generatedLinks[c.caseld])} className="text-[10px] font-semibold text-blue-600">Copy</button>
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-col gap-1.5 items-start">
                      <StatusPill done={c.acr_status === "Submitted"} pending={c.acr_status ?? "Not Started"} label="Submitted" />
                      {c.acr_status !== "Submitted" && (
                        <button
                          disabled={!canFileAcr || acrLoadingFor === c.caseld}
                          title={!canFileAcr ? "Only the assigned agent can file this" : undefined}
                          onClick={() => openAcrModal(c)}
                          className={`text-[11px] font-semibold ${!canFileAcr ? "text-slate-400 opacity-50 cursor-not-allowed" : "text-blue-600 hover:text-blue-700"}`}
                        >
                          {acrLoadingFor === c.caseld ? "Loading…" : c.acr_status === "Draft" ? "Continue ACR" : "Fill ACR"}
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button onClick={() => router.push(`/case/${c.caseld}`)} className="text-xs font-semibold text-blue-600 hover:text-blue-700">
                      Open case →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {acrModal && (
        <ACRModal
          caseId={acrModal.caseId}
          initial={acrModal.initial}
          onClose={() => setAcrModal(null)}
          onDone={() => { setAcrModal(null); load(); }}
        />
      )}

      {ippModal && (
        <IPPModal
          caseId={ippModal.caseId}
          customerName={ippModal.customerName}
          onClose={() => setIppModal(null)}
          onConfirmed={() => { setIppModal(null); load(); }}
        />
      )}
    </div>
  );
}
