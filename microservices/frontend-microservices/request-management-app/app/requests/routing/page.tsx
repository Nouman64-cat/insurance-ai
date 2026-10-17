"use client";

import { useCallback, useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { requestsApi, RequestsError, type RequestType, type Reviewer, type RoutingRule } from "@/lib/requestsApi";
import { PageHeader } from "@/components/RequestList";
import { useSummary } from "@/components/RequestsShell";
import {
  Card, Empty, ErrorNote, Spinner, TYPE_LABEL, dangerButton, formatDate, inputClass, labelClass, primaryButton, secondaryButton,
} from "@/components/ui";

// Routing rules for the tenant: who reviews each request type (optionally per branch). Administrators only; the
// server validates every target (active, same tenant, allowed to review the type) here and again at each submission.

type Draft = { id?: string; version?: number; request_type: string; branch_id: string; target_kind: "USER" | "ROLE";
  target_user_id: string; target_role: string; sla_hours: number; description: string };

const blank = (type: string, sla: number): Draft => ({ request_type: type, branch_id: "", target_kind: "ROLE", target_user_id: "", target_role: "", sla_hours: sla, description: "" });

export default function RoutingPage() {
  const { summary } = useSummary();
  const [rules, setRules] = useState<RoutingRule[] | null>(null);
  const [types, setTypes] = useState<RequestType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, t] = await Promise.all([requestsApi.rules(), requestsApi.types()]);
      setRules(r); setTypes(t); setError(null);
    } catch (e) {
      setError((e as RequestsError).message ?? tx("Couldn't load routing rules."));
    }
  }, []);
  useEffect(() => { if (summary?.is_admin) load(); }, [summary?.is_admin, load]);

  useEffect(() => {
    if (!draft?.request_type) return;
    requestsApi.reviewers(draft.request_type).then(setReviewers).catch(() => setReviewers([]));
  }, [draft?.request_type]);

  if (summary && !summary.is_admin) return <div className="px-6 py-10"><Empty title={tx("Routing is managed by tenant administrators.")} /></div>;

  const typeOf = (code: string) => types.find((t) => t.code === code);

  const save = async () => {
    if (!draft) return;
    setBusy(true); setSaveError(null);
    const target = draft.target_kind === "USER" ? { target_kind: "USER", target_user_id: draft.target_user_id } : { target_kind: "ROLE", target_role: draft.target_role };
    try {
      if (draft.id) {
        await requestsApi.updateRule(draft.id, { expected_version: draft.version, ...target, sla_hours: Number(draft.sla_hours), description: draft.description });
      } else {
        await requestsApi.createRule({ request_type: draft.request_type, branch_id: draft.branch_id.trim() || null, ...target,
          sla_hours: Number(draft.sla_hours), description: draft.description });
      }
      setDraft(null);
      await load();
    } catch (e) {
      const err = e as RequestsError;
      setSaveError(Object.values(err.fieldErrors?.() ?? {})[0] ?? err.message);
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async (rule: RoutingRule) => {
    const reason = window.prompt(tx("Why are you turning this rule off? New requests of this type will fail to submit until another rule covers them."));
    if (reason === null) return;
    try {
      await requestsApi.deactivateRule(rule.id, reason);
      await load();
    } catch (e) {
      setError((e as RequestsError).message);
    }
  };

  // One click for a tenant starting out: a team-queue rule for every request type that has none, sent to the first
  // role allowed to review it that has an active member. The server validates each one as usual.
  const activeTypes = new Set((rules ?? []).filter((r) => r.is_active && !r.branch_id).map((r) => r.request_type));
  const uncovered = types.filter((t) => !activeTypes.has(t.code));
  const setUpDefaults = async () => {
    setBusy(true); setError(null);
    const failed: string[] = [];
    for (const t of uncovered) {
      try {
        const people = await requestsApi.reviewers(t.code);
        const preferred = ["Underwriter", "ClaimsManager", "Admin"].filter((r) => t.review_roles.includes(r));
        const role = preferred.find((r) => people.some((p) => p.role_name === r)) ?? t.review_roles.find((r) => people.some((p) => p.role_name === r));
        if (!role) { failed.push(tx(TYPE_LABEL[t.code] ?? t.label)); continue; }
        await requestsApi.createRule({ request_type: t.code, target_kind: "ROLE", target_role: role, sla_hours: t.default_sla_hours,
          description: "Default rule" });
      } catch {
        failed.push(tx(TYPE_LABEL[t.code] ?? t.label));
      }
    }
    await load();
    setBusy(false);
    if (failed.length) setError(tx("No active reviewer in your tenant for: {types}. Add a user with a reviewing role, then try again.", { types: failed.join(", ") }));
  };

  const reviewRoles = draft ? typeOf(draft.request_type)?.review_roles ?? [] : [];
  const valid = !!draft && !!draft.request_type && (draft.target_kind === "USER" ? !!draft.target_user_id : !!draft.target_role)
    && draft.sla_hours >= 1 && draft.sla_hours <= 2160;

  return (
    <div className="mx-auto w-full max-w-screen-xl space-y-5 px-6 py-5">
      <PageHeader title={tx("Routing rules")} subtitle={tx("Who reviews each type of request. A branch rule wins over the tenant-wide rule for requests from that branch.")}>
        <button type="button" className={primaryButton} onClick={() => { setSaveError(null); setDraft(blank(types[0]?.code ?? "general", types[0]?.default_sla_hours ?? 72)); }}>
          {tx("+ New rule")}
        </button>
      </PageHeader>

      {draft && (
        <Card className="space-y-4 border-blue-200 p-5">
          <h2 className="text-sm font-bold text-slate-900">{draft.id ? tx("Edit rule") : tx("New rule")}</h2>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <label className={labelClass} htmlFor="rtype">{tx("Request type")}</label>
              <select id="rtype" className={inputClass} value={draft.request_type} disabled={!!draft.id}
                onChange={(e) => setDraft({ ...blank(e.target.value, typeOf(e.target.value)?.default_sla_hours ?? 72) })}>
                {types.map((t) => <option key={t.code} value={t.code}>{tx(TYPE_LABEL[t.code] ?? t.label)}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="branch">{tx("Branch id (empty: every branch)")}</label>
              <input id="branch" className={inputClass} value={draft.branch_id} disabled={!!draft.id} onChange={(e) => setDraft({ ...draft, branch_id: e.target.value })} />
            </div>
            <div>
              <label className={labelClass} htmlFor="sla">{tx("Time to decide (hours)")}</label>
              <input id="sla" type="number" min={1} max={2160} className={inputClass} value={draft.sla_hours} onChange={(e) => setDraft({ ...draft, sla_hours: Number(e.target.value) })} />
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <p className={labelClass}>{tx("Send to")}</p>
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-1.5"><input type="radio" checked={draft.target_kind === "ROLE"} onChange={() => setDraft({ ...draft, target_kind: "ROLE" })} /> {tx("A team queue")}</label>
                <label className="flex items-center gap-1.5"><input type="radio" checked={draft.target_kind === "USER"} onChange={() => setDraft({ ...draft, target_kind: "USER" })} /> {tx("One reviewer")}</label>
              </div>
            </div>
            <div className="md:col-span-2">
              {draft.target_kind === "ROLE" ? (
                <>
                  <label className={labelClass} htmlFor="role">{tx("Team")}</label>
                  <select id="role" className={inputClass} value={draft.target_role} onChange={(e) => setDraft({ ...draft, target_role: e.target.value })}>
                    <option value="">{tx("Choose…")}</option>
                    {reviewRoles.map((r) => <option key={r} value={r}>{tx("{role} queue", { role: r })}</option>)}
                  </select>
                </>
              ) : (
                <>
                  <label className={labelClass} htmlFor="user">{tx("Reviewer")}</label>
                  <select id="user" className={inputClass} value={draft.target_user_id} onChange={(e) => setDraft({ ...draft, target_user_id: e.target.value })}>
                    <option value="">{tx("Choose…")}</option>
                    {reviewers.map((r) => <option key={r.id} value={r.id}>{r.full_name} · {r.role_name}</option>)}
                  </select>
                  {reviewers.length === 0 && <p className="mt-1 text-[11px] text-slate-500">{tx("No active user in your tenant may review this type.")}</p>}
                </>
              )}
            </div>
          </div>
          <div>
            <label className={labelClass} htmlFor="desc">{tx("Note (optional)")}</label>
            <input id="desc" className={inputClass} value={draft.description} maxLength={500} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </div>
          {saveError && <ErrorNote message={saveError} />}
          <div className="flex justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={() => setDraft(null)} disabled={busy}>{tx("Close")}</button>
            <button type="button" className={primaryButton} onClick={save} disabled={!valid || busy}>{busy ? tx("Saving…") : tx("Save rule")}</button>
          </div>
        </Card>
      )}

      {rules && uncovered.length > 0 && !draft && (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-900">
            {tx("These request types have no reviewer yet, so they can't be submitted: {types}.", { types: uncovered.map((t) => tx(TYPE_LABEL[t.code] ?? t.label)).join(", ") })}
          </p>
          <button type="button" className={primaryButton} onClick={setUpDefaults} disabled={busy}>
            {busy ? tx("Setting up…") : tx("Set up default routing")}
          </button>
        </Card>
      )}
      {error && <ErrorNote message={error} onRetry={load} />}
      <Card>
        {!rules ? <Spinner /> : rules.length === 0 ? (
          <Empty title={tx("No routing rules yet.")} hint={tx("Until a rule covers a request type, requests of that type stay as drafts and can't be submitted.")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 text-start">{tx("Request type")}</th>
                  <th className="px-4 py-2.5 text-start">{tx("Branch")}</th>
                  <th className="px-4 py-2.5 text-start">{tx("Reviewed by")}</th>
                  <th className="px-4 py-2.5 text-start">{tx("Time to decide")}</th>
                  <th className="px-4 py-2.5 text-start">{tx("Updated")}</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id} className={`border-t border-slate-100 ${r.is_active ? "" : "opacity-50"}`}>
                    <td className="px-4 py-3 font-medium text-slate-800">{tx(TYPE_LABEL[r.request_type] ?? r.request_type)}{!r.is_active && ` · ${tx("Off")}`}</td>
                    <td className="px-4 py-3 text-xs text-slate-600">{r.branch_id ?? tx("Every branch")}</td>
                    <td className="px-4 py-3 text-slate-700">{r.target_kind === "ROLE" ? tx("{role} queue", { role: r.target_role ?? "" }) : r.target_label}</td>
                    <td className="px-4 py-3 text-xs text-slate-600">{tx("{h} hours", { h: r.sla_hours })}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{formatDate(r.updated_at, true)} · v{r.version}</td>
                    <td className="px-4 py-3 text-end">
                      {r.is_active && (
                        <div className="flex justify-end gap-2">
                          <button type="button" className="text-xs font-semibold text-blue-600" onClick={() => { setSaveError(null); setDraft({
                            id: r.id, version: r.version, request_type: r.request_type, branch_id: r.branch_id ?? "", target_kind: r.target_kind,
                            target_user_id: r.target_user_id ?? "", target_role: r.target_role ?? "", sla_hours: r.sla_hours, description: r.description }); }}>
                            {tx("Edit")}
                          </button>
                          <button type="button" className={`${dangerButton} !px-2 !py-1 text-xs`} onClick={() => deactivate(r)}>{tx("Turn off")}</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
