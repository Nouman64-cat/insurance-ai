"use client";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Banner, Card, EmptyState, ErrorState, Icon, PageHeader, Pill, Skeleton, errorText, useToast, tOr } from "@/components/ui";
import { MetricCard } from "@/components/MetricCard";
import { PolicyCardItem } from "@/components/PolicyCardItem";
import { RequestKind, RequestModal } from "@/components/RequestModal";
import { ApiError, api, useApi } from "@/lib/api";
import { compactMoney, date, dateTime, money } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { BeneficiariesView, FamilyOverview, FamilyRequest, MemberRow } from "@/lib/types";

const TABS = ["policies", "members", "beneficiaries", "requests"] as const;
type Tab = (typeof TABS)[number];

function Members({ o, onRequest }: { o: FamilyOverview; onRequest: (k: RequestKind, m?: MemberRow) => void }) {
  const { t, locale } = useI18n();
  const rows = o.members_list;
  const canEdit = o.role === "head" && o.totals.policies_in_force > 0;
  return (
    <Card title={t("family.membersTitle")} action={canEdit ? <button type="button" className="btn-secondary !py-1.5 !min-h-0 text-xs" onClick={() => onRequest("MEMBER_ADD")}>{t("family.addMember")}</button> : undefined}>
      <p className="text-xs text-slate-500 mb-3">{t("family.membersNote")}</p>
      <div className="overflow-x-auto -mx-5">
        <table className="w-full min-w-[820px]">
          <thead><tr><th className="th">{t("profile.name")}</th><th className="th">{t("policy.relationship")}</th><th className="th">{t("family.age")}</th><th className="th">{t("family.status")}</th>
            <th className="th">{t("pay.policy")}</th><th className="th">{t("family.cover")}</th><th className="th">{t("family.since")}</th><th className="th" /></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={`${r.key}-${r.policy_id}`}>
              <td className="td font-semibold text-slate-800">{r.name}{r.is_you && <span className="ms-2 text-[10px] text-blue-700 bg-blue-50 rounded-full px-2 py-0.5">{t("family.you")}</span>}
                {r.is_minor && <span className="ms-2 text-[10px] text-amber-700 bg-amber-50 rounded-full px-2 py-0.5">{t("policy.minor")}</span>}</td>
              <td className="td">{tOr(t, `relationship.${r.relationship}`, r.relationship)}</td>
              <td className="td ltr-num">{r.dob ? `${date(r.dob, locale)} (${r.age ?? "—"})` : r.age ?? "—"}</td>
              <td className="td">{r.kind === "insured"
                ? <Pill tone={r.eligibility === "covered" ? "green" : r.eligibility === "pending" ? "blue" : "slate"}>{t(`family.eligibility.${r.eligibility}`)}</Pill>
                : <Pill tone="slate">{t("family.nomineeOnly")}</Pill>}{r.kind === "nominee" && r.also_insured && <span className="block text-[10px] text-slate-400 mt-0.5">{t("family.alsoInsured")}</span>}</td>
              <td className="td ltr-num">{r.policy_number}<span className="block text-[10px] text-slate-400">{t(`plan.${r.plan_type}`)}</span></td>
              <td className="td ltr-num">{r.coverage ? <>{money(r.coverage.amount)}<span className="block text-[10px] text-slate-400">{r.coverage.kind === "shared_pool" ? t("family.sharedPool") : t("family.ownCover")}</span></> : r.share_pct != null ? `${r.share_pct}% ${t("family.ofBenefit")}` : "—"}</td>
              <td className="td">{date(r.coverage_effective_date, locale)}</td>
              <td className="td text-end whitespace-nowrap">{r.can_manage && r.eligibility !== "ended" && o.totals.policies_in_force > 0 && !(r.relationship === "Self" && r.kind === "insured") && (
                <><button type="button" className="text-xs font-semibold text-blue-600 hover:text-blue-700 me-3" onClick={() => onRequest("MEMBER_CORRECTION", r)}>{t("family.correct")}</button>
                  <button type="button" className="text-xs font-semibold text-rose-600 hover:text-rose-700" onClick={() => onRequest("MEMBER_REMOVE", r)}>{t("common.remove")}</button></>)}</td>
            </tr>))}</tbody>
        </table>
      </div>
    </Card>
  );
}

function Beneficiaries({ o, onRequest }: { o: FamilyOverview; onRequest: (k: RequestKind, policyId: string, view: BeneficiariesView) => void }) {
  const { t, locale } = useI18n();
  const policies = o.arrangements.flatMap((a) => a.policies).filter((p) => p.access !== "summary");
  const [pid, setPid] = useState(policies[0]?.id || "");
  const { data, error, loading, reload } = useApi<BeneficiariesView>(pid ? `family/${encodeURIComponent(o.id)}/beneficiaries?policy_id=${encodeURIComponent(pid)}` : null);
  if (policies.length === 0) return <div className="card"><EmptyState title={t("family.noBeneficiaryAccess")} text={t("family.noBeneficiaryAccessText")} /></div>;
  return (
    <div className="space-y-4">
      {policies.length > 1 && (
        <select aria-label={t("pay.policy")} className="input max-w-md" value={pid} onChange={(e) => setPid(e.target.value)}>
          {policies.map((p) => <option key={p.id} value={p.id}>{p.policy_number} — {p.product_name} ({p.holder_name})</option>)}</select>)}
      {error && !data ? <div className="card"><ErrorState error={error} onRetry={reload} /></div> : loading && !data ? <Skeleton className="h-40" /> : data && (
        <>
          {!data.complete && <Banner tone="warning" title={t("family.nominationIncomplete")}>{t("family.nominationIncompleteText", { total: data.total_share })}</Banner>}
          <Card title={t("family.beneficiaries")} action={data.can_request_change ? <button type="button" className="btn-secondary !py-1.5 !min-h-0 text-xs" onClick={() => onRequest("NOMINEE_CHANGE", pid, data)}>{t("family.changeNominees")}</button> : undefined}>
            {data.beneficiaries.length === 0 ? <EmptyState title={t("policy.noNominees")} /> : (
              <div className="overflow-x-auto -mx-5">
                <table className="w-full"><thead><tr><th className="th">{t("profile.name")}</th><th className="th">{t("policy.relationship")}</th><th className="th">{t("policy.share")}</th><th className="th">{t("family.minorGuardian")}</th></tr></thead>
                  <tbody>{data.beneficiaries.map((b) => (
                    <tr key={b.id}><td className="td font-semibold">{b.name}</td><td className="td">{tOr(t, `relationship.${b.relationship}`, b.relationship)}</td><td className="td ltr-num">{b.share_pct}%</td>
                      <td className="td">{b.is_minor ? <>{t("policy.minor")} · {t("family.guardian")}: <span className="font-semibold">{b.guardian_name || "—"}</span></> : "—"}</td></tr>))}
                    <tr><td className="td font-bold" colSpan={2}>{t("family.total")}</td><td className={`td font-bold ltr-num ${data.complete ? "text-emerald-700" : "text-rose-600"}`}>{data.total_share}%</td><td className="td" /></tr></tbody></table>
              </div>)}
            {!data.can_request_change && data.change_blocked_reason && <p className="text-xs text-slate-400 mt-3">{t(`family.blocked.${data.change_blocked_reason}`)}</p>}
            <p className="text-xs text-slate-400 mt-3">{t("family.nomineeNotInsured")}</p>
          </Card>
          <Card title={t("family.versionHistory")}>
            {data.versions.length === 0 ? <p className="text-sm text-slate-500">{t("family.noVersions")}</p> : (
              <ol className="relative border-s border-slate-200 ms-2 space-y-4">{data.versions.map((v) => (
                <li key={v.sequence} className="ms-4"><span className="absolute -start-[5px] mt-1.5 w-2.5 h-2.5 rounded-full bg-blue-500 ring-4 ring-white" aria-hidden="true" />
                  <p className="text-sm font-semibold text-slate-800">{t("family.version", { n: v.sequence })} · {t(`family.changedBy.${v.changed_by}`)}</p>
                  <p className="text-xs text-slate-400">{dateTime(v.at, locale)}{v.reason ? ` · ${v.reason}` : ""}</p>
                  <p className="text-xs text-slate-600 mt-1">{v.beneficiaries.map((b) => `${b.name} ${b.share_pct}%`).join(", ")}</p></li>))}</ol>)}
          </Card>
        </>)}
    </div>
  );
}

function Requests({ familyId, refreshKey }: { familyId: string; refreshKey: number }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<{ items: FamilyRequest[] }>("family/requests");
  useEffect(() => { if (refreshKey) reload(); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = (data?.items || []).filter((r) => r.family_id === familyId);
  async function withdraw(id: string) {
    try { await api(`family/requests/${id}/withdraw`, { method: "POST" }); toast(t("family.withdrawn"), "success"); reload(); }
    catch (e) { toast(errorText(t, e as ApiError), "error"); }
  }
  if (error && !data) return <div className="card"><ErrorState error={error} onRetry={reload} /></div>;
  return (
    <Card title={t("family.requests")}>
      <p className="text-xs text-slate-500 mb-3">{t("family.requestsNote")}</p>
      {loading && !data ? <Skeleton className="h-24" /> : items.length === 0 ? <EmptyState title={t("family.noRequests")} text={t("family.noRequestsText")} /> : (
        <div className="overflow-x-auto -mx-5"><table className="w-full"><thead><tr><th className="th">{t("family.reference")}</th><th className="th">{t("family.requestType")}</th><th className="th">{t("pay.policy")}</th><th className="th">{t("family.sent")}</th><th className="th">{t("payments.status")}</th><th className="th" /></tr></thead>
          <tbody>{items.map((r) => (
            <tr key={r.id}><td className="td ltr-num font-semibold">{r.reference}</td><td className="td">{t(`request.kind.${r.kind}`)}</td><td className="td ltr-num">{r.policy_number}</td><td className="td">{dateTime(r.created_at, locale)}</td>
              <td className="td"><Pill tone={r.status === "SUBMITTED" ? "blue" : "slate"}>{t(`family.requestStatus.${r.status}`)}</Pill></td>
              <td className="td text-end">{r.status === "SUBMITTED" && <button type="button" className="text-xs font-semibold text-rose-600" onClick={() => withdraw(r.id)}>{t("family.withdraw")}</button>}</td></tr>))}</tbody></table></div>)}
    </Card>
  );
}

function Detail() {
  const { t, locale } = useI18n();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const tab = (TABS as readonly string[]).includes(params.get("tab") || "") ? (params.get("tab") as Tab) : "policies";
  const { data: o, error, loading, reload } = useApi<FamilyOverview>(`family/${encodeURIComponent(id)}`);
  const [dialog, setDialog] = useState<{ kind: RequestKind; member?: MemberRow | null; policyId?: string; view?: BeneficiariesView | null } | null>(null);
  const [reqKey, setReqKey] = useState(0);
  const setTab = (k: Tab) => router.replace(`/family/${id}?tab=${k}`);

  if (error && !o) {
    return <div className="card">{(error as ApiError).code === "NOT_FOUND"
      ? <EmptyState title={t("family.notFound")} text={t("family.notFoundText")} action={<Link href="/family" className="btn-primary">{t("family.title")}</Link>} /> : <ErrorState error={error} onRetry={reload} />}</div>;
  }
  if (loading || !o) return <div className="space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-28" /><Skeleton className="h-64" /></div>;

  const allPolicies = o.arrangements.flatMap((a) => a.policies);
  const claimPolicy = allPolicies.find((p) => p.access !== "summary" && p.in_force);
  const dialogPolicy = (pid?: string) => allPolicies.find((p) => p.id === pid) || allPolicies.find((p) => p.access === "owner" && p.in_force) || claimPolicy;
  const p = dialog ? dialogPolicy(dialog.policyId || dialog.member?.policy_id) : undefined;

  return (
    <div className="space-y-5">
      <PageHeader title={o.name} subtitle={<>{o.plan_types.map((x) => t(`plan.${x}`)).join(" · ")} · {t(`family.role.${o.role}`)}</>}
        actions={<>{claimPolicy && <Link href={`/claims/new?policy=${claimPolicy.id}`} className="btn-secondary">{t("policy.fileClaim")}</Link>}
          <Link href="/payments?segment=family" className="btn-primary">{t("nav.payments")}</Link></>} />
      {o.members.insured_total > o.members.insured && <Banner tone="info">{t("family.someNotInForce")}</Banner>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard title={t("family.members")} value={o.members.listed} accent="blue" icon={<Icon name="family" />} subtitle={t("family.listedNote")} />
        <MetricCard title={t("family.insured")} value={o.members.insured} accent="emerald" icon={<Icon name="shield" />} subtitle={t("family.nomineesCount", { count: o.members.nominees })} />
        <MetricCard title={t("family.coverage")} value={compactMoney(o.totals.coverage)} accent="emerald" icon={<Icon name="check" />} subtitle={t("family.coverageNote")} />
        <MetricCard title={t("dashboard.nextPremium")} value={o.totals.next_premium ? money(o.totals.next_premium.amount) : t("dashboard.none")} accent="sky" icon={<Icon name="calendar" />}
          subtitle={o.totals.next_premium ? `${date(o.totals.next_premium.date, locale)} · ${o.totals.next_premium.policy_number}` : t("dashboard.noUpcoming")} />
        <MetricCard title={t("dashboard.outstanding")} value={money(o.totals.outstanding)} accent={o.totals.outstanding > 0 ? "red" : "slate"} icon={<Icon name="money" />} subtitle={o.totals.outstanding > 0 ? t("dashboard.outstandingDue") : t("dashboard.nothingDue")} />
        <MetricCard title={t("dashboard.openClaims")} value={o.totals.open_claims} accent="slate" icon={<Icon name="claims" />} subtitle={t("dashboard.openClaimsNote")} />
        <MetricCard title={t("family.activePolicies")} value={o.totals.policies_in_force} accent="blue" icon={<Icon name="policies" />} subtitle={t("family.ofTotal", { total: o.totals.policies_total })} />
        <MetricCard title={t("family.renewals")} value={o.totals.renewals_soon.length} accent={o.totals.renewals_soon.length ? "amber" : "slate"} icon={<Icon name="calendar" />}
          subtitle={o.totals.renewals_soon[0] ? `${o.totals.renewals_soon[0].policy_number} · ${date(o.totals.renewals_soon[0].date, locale)}` : t("family.noRenewals")} />
      </div>

      <div role="tablist" aria-label={t("family.sections")} className="flex gap-1 overflow-x-auto border-b border-slate-200">
        {TABS.map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`px-4 py-2.5 text-sm font-semibold whitespace-nowrap border-b-2 -mb-px transition-colors ${tab === k ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>{t(`family.tab.${k}`)}</button>))}
      </div>

      {tab === "policies" && (
        <div className="space-y-6">
          {o.arrangements.map((a) => (
            <section key={a.family_policy_id} aria-label={a.plan_label}>
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
                <h3 className="text-sm font-bold text-slate-800">{t(`plan.${a.plan_type}`)} <span className="text-xs font-medium text-slate-400">· {t("family.since")} {date(a.effective_date, locale)}</span></h3>
                {a.plan_type === "Floater" && a.shared_sum_insured != null && <p className="text-xs text-slate-500">{t("family.sharedPoolNote", { amount: money(a.shared_sum_insured) })}</p>}
                {a.plan_type === "LifeBundle" && a.discount_percentage != null && <p className="text-xs text-slate-500">{t("family.bundleNote", { pct: a.discount_percentage })}</p>}
              </div>
              <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">{a.policies.map((p) => <PolicyCardItem key={p.id} p={p} />)}</div>
            </section>))}
          {allPolicies.length === 0 && <div className="card"><EmptyState title={t("policies.none")} /></div>}
        </div>)}
      {tab === "members" && <Members o={o} onRequest={(kind, member) => setDialog({ kind, member })} />}
      {tab === "beneficiaries" && <Beneficiaries o={o} onRequest={(kind, policyId, view) => setDialog({ kind, policyId, view })} />}
      {tab === "requests" && <Requests familyId={o.id} refreshKey={reqKey} />}

      {dialog && <RequestModal familyId={o.id} kind={dialog.kind} policy={p ? { id: p.id, policy_number: p.policy_number, sum_assured: p.sum_assured } : undefined} member={dialog.member} nominees={dialog.view}
        onClose={() => setDialog(null)} onDone={() => { setReqKey((n) => n + 1); }} />}
    </div>
  );
}

export default function FamilyDetailPage() { return <Suspense><Detail /></Suspense>; }
