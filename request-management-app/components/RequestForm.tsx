"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import api from "@/app/services/api";
import { tx } from "@/lib/i18n/tx";
import { PAKISTAN_PROVINCES } from "@/lib/pakistanProvinces";
import DemoFillButton from "@/components/DemoFillButton";
import { useSummary } from "./RequestsShell";
import { demoDispute, demoGeneralRequest, demoPriority, demoProfileCorrection } from "@/lib/demoData";
import { newKey, requestsApi, RequestsError, type Priority, type RequestDetail, type RequestType } from "@/lib/requestsApi";
import {
  CATEGORY_LABEL, Card, DISPUTE_LABEL, ErrorNote, PRIORITY_LABEL, Spinner, TYPE_LABEL, inputClass, labelClass, primaryButton, secondaryButton,
} from "./ui";

// The request form (new requests, and editing a draft or a request returned for more information). The type decides the form; the server validates everything again and decides who reviews it.

const MARITAL = ["Single", "Married", "Divorced", "Widowed"];

function currentValue(customer: any, key: string): string {
  if (!customer) return "";
  if (["city", "province", "marital_status"].includes(key)) return customer[key] ?? "";
  const [section, name] = key.split(".");
  return customer.details?.[section]?.[name] ?? "";
}

/** The request form. With `editing`, it edits that request's proposal (a draft, or one returned for more information). */
export function NewRequestForm({ editing }: { editing?: RequestDetail }) {
  const router = useRouter();
  const params = useSearchParams();
  const { summary } = useSummary();
  const [routingMissing, setRoutingMissing] = useState(false);
  const initial = (editing?.current_revision?.payload ?? {}) as Record<string, any>;
  const [types, setTypes] = useState<RequestType[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState(editing?.request_type ?? params.get("type") ?? "");
  const [title, setTitle] = useState(editing?.title ?? "");
  const [priority, setPriority] = useState<Priority>(editing?.priority ?? "NORMAL");
  // general
  const [category, setCategory] = useState<string>(initial.category ?? "OTHER");
  const [description, setDescription] = useState<string>(initial.description ?? "");
  const [desired, setDesired] = useState<string>(initial.desired_outcome ?? "");
  // customer correction
  const [customerId, setCustomerId] = useState<string>(initial.customer_id ?? params.get("customer_id") ?? "");
  const [customer, setCustomer] = useState<any | null>(null);
  const [customerError, setCustomerError] = useState<string | null>(null);
  const [changes, setChanges] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(initial.changes ?? {}).map(([k, v]) => [k, (v as string | null) ?? ""])));
  const [reason, setReason] = useState<string>(initial.reason ?? "");
  // commission dispute
  const [earningId, setEarningId] = useState<string>(initial.earning_id ?? params.get("earning_id") ?? "");
  const [earning, setEarning] = useState<any | null>(null);
  const [earningError, setEarningError] = useState<string | null>(null);
  const [disputeKind, setDisputeKind] = useState<string>(initial.dispute_kind ?? "AMOUNT");
  const [claimed, setClaimed] = useState<string>(initial.claimed_amount ?? "");
  const [explanation, setExplanation] = useState<string>(initial.explanation ?? "");

  const [busy, setBusy] = useState<"draft" | "submit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [draftId, setDraftId] = useState<string | null>(editing?.id ?? null);
  // A request returned for more information is resubmitted from its page (with an answer for the reviewer).
  const canSubmitHere = !editing || editing.review_status === "DRAFT";
  // One key per attempt to create / submit: a double click or a retry after a network error acts once.
  const createKey = useRef(newKey());
  const submitKey = useRef(newKey());

  useEffect(() => {
    requestsApi.types().then((all) => {
      const mine = all.filter((t) => t.can_submit);
      setTypes(mine);
      if (!editing && !mine.some((t) => t.code === code)) setCode(mine.length === 1 ? mine[0].code : "");
      if (editing) setTypes(all.filter((t) => t.code === editing.request_type));
    }).catch((e) => setLoadError(e instanceof RequestsError ? e.message : tx("Couldn't load request types.")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const type = useMemo(() => types?.find((t) => t.code === code) ?? null, [types, code]);
  const tenantId = typeof window !== "undefined" ? localStorage.getItem("tenant_id") : null;

  // The referenced record, loaded with the user's own access (an agent only finds their own customers and earnings).
  useEffect(() => {
    setCustomer(null); setCustomerError(null);
    if (code !== "customer_profile_correction" || !/^[0-9a-f-]{36}$/i.test(customerId.trim()) || !tenantId) return;
    let current = true;
    api.get(`/tenants/${tenantId}/customers/${customerId.trim()}`)
      .then((r) => { if (current) { setCustomer(r.data); if (!title) setTitle(tx("Correct {name}'s profile", { name: r.data.name })); } })
      .catch(() => { if (current) setCustomerError(tx("That customer doesn't exist or you don't have access to it.")); });
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, customerId, tenantId]);

  useEffect(() => {
    setEarning(null); setEarningError(null);
    if (code !== "commission_dispute" || !/^[0-9a-f-]{36}$/i.test(earningId.trim()) || !tenantId) return;
    let current = true;
    api.get(`/tenants/${tenantId}/commissions/earnings/${earningId.trim()}`)
      .then((r) => { if (current) { setEarning(r.data); if (!title) setTitle(tx("Commission dispute")); } })
      .catch(() => { if (current) setEarningError(tx("That earning doesn't exist or you don't have access to it.")); });
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, earningId, tenantId]);

  // Demo mode only (ENV_VAR=demo): fill the form with realistic values, using a customer or earning this user can see.
  const [demoNote, setDemoNote] = useState<string | null>(null);
  const fillDemo = async () => {
    setDemoNote(null); setError(null); setFieldErrors({});
    setPriority(demoPriority());
    if (code === "general") {
      const g = demoGeneralRequest();
      setTitle(g.title); setCategory(g.category); setDescription(g.description); setDesired(g.desiredOutcome);
      return;
    }
    if (code === "customer_profile_correction") {
      let target = customer;
      if (!target && tenantId) {
        const list = await api.get(`/tenants/${tenantId}/customers`).then((r) => (Array.isArray(r.data) ? r.data : r.data?.items ?? [])).catch(() => []);
        const individuals = list.filter((c: any) => !c.organization_id);
        target = (individuals.length ? individuals : list)[Math.floor(Math.random() * Math.max(1, (individuals.length || list.length)))] ?? null;
        if (target) setCustomerId(target.id);
      }
      if (!target) { setDemoNote(tx("There's no customer you can see yet, so the customer id is left empty.")); }
      const c = demoProfileCorrection();
      setChanges(c.changes); setReason(c.reason);
      setTitle(target ? tx("Correct {name}'s profile", { name: target.name }) : tx("Correct a customer's contact details"));
      return;
    }
    if (code === "commission_dispute") {
      let target = earning;
      if (!target && tenantId) {
        const page = await api.get(`/tenants/${tenantId}/commissions/earnings`, { params: { limit: 50 } }).then((r) => r.data?.items ?? []).catch(() => []);
        target = page[Math.floor(Math.random() * Math.max(1, page.length))] ?? null;
        if (target) setEarningId(target.id);
      }
      if (!target) setDemoNote(tx("There are no commission earnings you can see yet, so the earning id is left empty."));
      const d = demoDispute(target?.gross_amount);
      setDisputeKind(d.kind); setClaimed(d.claimed); setExplanation(d.explanation);
      setTitle(tx("Commission dispute"));
    }
  };

  const payload = () => {
    if (code === "general") return { category, description: description.trim(), ...(desired.trim() ? { desired_outcome: desired.trim() } : {}) };
    if (code === "customer_profile_correction") {
      return { customer_id: customerId.trim(), changes: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.trim() || null])), reason: reason.trim() };
    }
    return { earning_id: earningId.trim(), dispute_kind: disputeKind, ...(claimed.trim() ? { claimed_amount: claimed.trim() } : {}), explanation: explanation.trim() };
  };

  const save = async (andSubmit: boolean) => {
    setError(null); setFieldErrors({}); setRoutingMissing(false);
    if (title.trim().length < 3) { setFieldErrors({ title: tx("Give the request a title of at least 3 characters.") }); return; }
    if (code === "customer_profile_correction" && Object.keys(changes).length === 0) { setFieldErrors({ changes: tx("Choose at least one field to correct.") }); return; }
    setBusy(andSubmit ? "submit" : "draft");
    let id = draftId;
    try {
      if (!id) {
        const created = await requestsApi.create({ request_type: code, title: title.trim(), priority, payload: payload() }, createKey.current);
        id = created.id;
        setDraftId(id);
        if (!andSubmit) { router.push(`/requests/${id}`); return; }
        await requestsApi.action(id, "submit", { expected_version: created.version }, submitKey.current);
      } else {
        const latest = await requestsApi.updateDraft(id, { expected_version: (await requestsApi.get(id)).version, title: title.trim(), priority, payload: payload() });
        if (andSubmit) await requestsApi.action(id, "submit", { expected_version: latest.version }, submitKey.current);
      }
      router.push(`/requests/${id}`);
    } catch (e) {
      if (e instanceof RequestsError) {
        setFieldErrors(e.fieldErrors());
        setError(e.code === "ROUTING_FAILED" ? `${e.message} ${tx("Your request was saved as a draft.")}` : e.message);
        setRoutingMissing(e.code === "ROUTING_FAILED");
      } else {
        setError(tx("Something went wrong. Try again."));
      }
      submitKey.current = newKey();
    } finally {
      setBusy(null);
    }
  };

  if (loadError) return <ErrorNote message={loadError} onRetry={() => location.reload()} />;
  if (!types) return <Spinner />;
  if (types.length === 0) return <ErrorNote message={tx("Your role can't raise requests.")} />;

  const fieldError = (name: string) => fieldErrors[name] ? <p className="mt-1 text-xs text-red-600">{fieldErrors[name]}</p> : null;

  return (
    <div className="space-y-5">
      {!editing && <Card className="p-5">
        <p className={labelClass}>{tx("What do you need?")}</p>
        <div className="grid gap-3 md:grid-cols-3">
          {types.map((t) => (
            <button key={t.code} type="button" onClick={() => { setCode(t.code); setFieldErrors({}); setError(null); }} aria-pressed={code === t.code}
              className={`rounded-xl border p-4 text-start transition-colors ${code === t.code ? "border-blue-500 bg-blue-50" : "border-slate-200 hover:bg-slate-50"}`}>
              <p className="text-sm font-semibold text-slate-900">{tx(TYPE_LABEL[t.code] ?? t.label)}</p>
              <p className="mt-1 text-xs text-slate-500">{tx(t.description)}</p>
            </button>
          ))}
        </div>
      </Card>}

      {type && (
        <Card className="space-y-4 p-5">
          <div className="flex items-center justify-end">
            <DemoFillButton onFill={fillDemo} />
          </div>
          {demoNote && <p className="rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-800">{demoNote}</p>}
          <div className="grid gap-4 md:grid-cols-3">
            <div className="md:col-span-2">
              <label className={labelClass} htmlFor="title">{tx("Title")}</label>
              <input id="title" className={inputClass} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
              {fieldError("title")}
            </div>
            <div>
              <label className={labelClass} htmlFor="priority">{tx("Priority")}</label>
              <select id="priority" className={inputClass} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                {Object.entries(PRIORITY_LABEL).map(([p, l]) => <option key={p} value={p}>{tx(l)}</option>)}
              </select>
            </div>
          </div>

          {code === "general" && (
            <>
              <div>
                <label className={labelClass} htmlFor="category">{tx("Category")}</label>
                <select id="category" className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)}>
                  {(type.categories ?? []).map((c) => <option key={c} value={c}>{tx(CATEGORY_LABEL[c] ?? c)}</option>)}
                </select>
              </div>
              <div>
                <label className={labelClass} htmlFor="description">{tx("Describe what you need and why")}</label>
                <textarea id="description" rows={5} className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} />
                {fieldError("description")}
              </div>
              <div>
                <label className={labelClass} htmlFor="desired">{tx("Desired outcome (optional)")}</label>
                <textarea id="desired" rows={2} className={inputClass} value={desired} onChange={(e) => setDesired(e.target.value)} />
              </div>
            </>
          )}

          {code === "customer_profile_correction" && (
            <>
              <div>
                <label className={labelClass} htmlFor="customer">{tx("Customer id")}</label>
                <input id="customer" className={inputClass} value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />
                {customer && <p className="mt-1 text-xs font-semibold text-emerald-700">{customer.name}{customer.cnic ? ` · ${customer.cnic}` : ""}</p>}
                {customerError && <p className="mt-1 text-xs text-red-600">{customerError}</p>}
                {fieldError("customer_id")}
                <p className="mt-1 text-[11px] text-slate-500">{tx("Open the customer in the portal and use “Request a correction” to fill this in.")}</p>
              </div>
              <div>
                <p className={labelClass}>{tx("Fields to correct")}</p>
                <p className="mb-2 text-[11px] text-slate-500">{tx("Only contact, address and marital details can be corrected through a request. Name, CNIC, date of birth and underwriting details can't.")}</p>
                <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {(type.fields ?? []).map((f) => {
                    const on = f.key in changes;
                    return (
                      <div key={f.key} className="grid items-center gap-2 px-3 py-2 md:grid-cols-[14rem_1fr_1fr]">
                        <label className="flex items-center gap-2 text-sm text-slate-700">
                          <input type="checkbox" checked={on} onChange={(e) => setChanges((c) => {
                            const next = { ...c };
                            if (e.target.checked) next[f.key] = currentValue(customer, f.key); else delete next[f.key];
                            return next;
                          })} />
                          {tx(f.label)}
                        </label>
                        <span className="text-xs text-slate-500">{tx("Now:")} {currentValue(customer, f.key) || "—"}</span>
                        {on && (f.key === "province" || f.key === "marital_status" ? (
                          <select className={inputClass} value={changes[f.key]} onChange={(e) => setChanges((c) => ({ ...c, [f.key]: e.target.value }))}>
                            <option value="">—</option>
                            {(f.key === "province" ? [...PAKISTAN_PROVINCES] : MARITAL).map((o) => <option key={o} value={o}>{tx(o)}</option>)}
                          </select>
                        ) : (
                          <input className={inputClass} value={changes[f.key]} onChange={(e) => setChanges((c) => ({ ...c, [f.key]: e.target.value }))}
                            aria-label={tx("New value for {field}", { field: f.label })} />
                        ))}
                      </div>
                    );
                  })}
                </div>
                {fieldError("changes")}
              </div>
              <div>
                <label className={labelClass} htmlFor="reason">{tx("Reason for the correction")}</label>
                <textarea id="reason" rows={3} className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
                {fieldError("reason")}
              </div>
            </>
          )}

          {code === "commission_dispute" && (
            <>
              <div>
                <label className={labelClass} htmlFor="earning">{tx("Commission earning id")}</label>
                <input id="earning" className={inputClass} value={earningId} onChange={(e) => setEarningId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />
                {earning && <p className="mt-1 text-xs font-semibold text-emerald-700">{tx("PKR {amount} at {rate}% · policy year {year}", { amount: earning.gross_amount, rate: earning.rate_pct, year: earning.policy_year })}</p>}
                {earningError && <p className="mt-1 text-xs text-red-600">{earningError}</p>}
                {fieldError("earning_id")}
                <p className="mt-1 text-[11px] text-slate-500">{tx("Use “Dispute” on an earning in the portal's commission ledger to fill this in.")}</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className={labelClass} htmlFor="kind">{tx("What's wrong")}</label>
                  <select id="kind" className={inputClass} value={disputeKind} onChange={(e) => setDisputeKind(e.target.value)}>
                    {(type.dispute_kinds ?? []).map((k) => <option key={k} value={k}>{tx(DISPUTE_LABEL[k] ?? k)}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelClass} htmlFor="claimed">{tx("Amount you expected (PKR, optional)")}</label>
                  <input id="claimed" inputMode="decimal" className={inputClass} value={claimed} onChange={(e) => setClaimed(e.target.value)} />
                  {fieldError("claimed_amount")}
                </div>
              </div>
              <div>
                <label className={labelClass} htmlFor="explanation">{tx("Explain the dispute")}</label>
                <textarea id="explanation" rows={4} className={inputClass} value={explanation} onChange={(e) => setExplanation(e.target.value)} />
                {fieldError("explanation")}
              </div>
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600">{tx("The decision on a dispute is recorded here. Any correction to the commission itself is made separately by the commission team.")}</p>
            </>
          )}

          {error && <ErrorNote message={error} />}
          {(routingMissing || (draftId && error && !editing)) && (
            <div className="flex flex-wrap gap-4">
              {routingMissing && summary?.is_admin && (
                <Link href="/requests/routing" className="text-xs font-semibold text-blue-600">{tx("Set up routing now →")}</Link>
              )}
              {draftId && !editing && <Link href={`/requests/${draftId}`} className="text-xs font-semibold text-blue-600">{tx("Open the saved draft")}</Link>}
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4">
            {editing && <Link href={`/requests/${editing.id}`} className={secondaryButton}>{tx("Back without saving")}</Link>}
            <button type="button" className={secondaryButton} disabled={!!busy} onClick={() => save(false)}>{busy === "draft" ? tx("Saving…") : editing ? tx("Save changes") : tx("Save as draft")}</button>
            {canSubmitHere && <button type="button" className={primaryButton} disabled={!!busy} onClick={() => save(true)}>{busy === "submit" ? tx("Submitting…") : tx("Submit request")}</button>}
          </div>
        </Card>
      )}
    </div>
  );
}
