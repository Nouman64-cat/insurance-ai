"use client";
import { useEffect, useMemo, useState } from "react";
import { Banner, Field, Skeleton, Spinner, errorText } from "@/components/ui";
import type { ApiError } from "@/lib/api";
import { demoFamily } from "@/lib/demoWalkIn";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { WalkInPlan } from "@/lib/types";
import {
  FAMILY_TABS, FamilyDetails, FamilyRow, FamilyTab, MemberKind, NOMINEE_RELATIONSHIPS, PROVINCES, blankRow, buildFamily, emptyFamily, familyGaps, isInsured, optionKey, startRows, totalShare,
} from "@/lib/walkinForm";

// "For my family": the same three tabs, in the same order and with the same fields, as the insurer's "Add New Family" form
// (Family Details, Insurance Plan, Family Members), so what reaches the agent is exactly what they would have entered.
const CELL = "w-full [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none bg-slate-50 border border-slate-200 rounded-md px-2 py-1 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 disabled:bg-slate-100 disabled:text-slate-300 disabled:cursor-not-allowed";
const CONTACT = ["Any", "Phone", "WhatsApp", "Email"] as const;
const pkr = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;

interface Props {
  plans: WalkInPlan[] | undefined;
  plansLoading: boolean;
  email: string;
  initialPlanId: string;
  demoTick: number;                                  // increases each time "Fill demo data" is pressed
  busy: boolean;
  error: ApiError | null;
  onSubmit: (body: Record<string, unknown>) => void;
  onField?: (tab: FamilyTab) => void;
}

export function FamilyApplication({ plans, plansLoading, email, initialPlanId, demoTick, busy, error, onSubmit, onField }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<FamilyTab>("details");
  const [d, setD] = useState<FamilyDetails>(() => ({ ...emptyFamily(), plan_id: initialPlanId }));
  const [rows, setRows] = useState<FamilyRow[]>(startRows);
  const set = (patch: Partial<FamilyDetails>) => setD((s) => ({ ...s, ...patch }));
  const gaps = familyGaps(d, rows);
  const valid = FAMILY_TABS.every((k) => gaps[k].length === 0);
  const idx = FAMILY_TABS.indexOf(tab);
  const bundle = d.kind === "LifeBundle";
  const familyPlans = useMemo(() => (plans || []).filter((p) => p.category === "Family"), [plans]);
  const chosen = familyPlans.find((p) => p.id === d.plan_id);

  useEffect(() => { if (initialPlanId && !d.plan_id) set({ plan_id: initialPlanId }); }, [initialPlanId]);     // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (demoTick === 0 || !plans) return;
    const demo = demoFamily(plans, d.plan_id);
    setD(demo.details); setRows(demo.rows);
  }, [demoTick]);                                                                                                 // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onField?.(tab); }, [tab]);                                                                    // eslint-disable-line react-hooks/exhaustive-deps

  const patchRow = (i: number, patch: Partial<FamilyRow>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const miss = (i: number, f: string) => gaps.members.includes(`row.${i}.${f}`);
  const cell = (i: number, f: string) => `${CELL} ${miss(i, f) ? "!border-amber-400 !bg-amber-50" : ""}`;
  const nominees = rows.filter((r) => r.kind !== "Self");
  const total = totalShare(rows);
  const base = bundle ? Number(rows.find((r) => r.kind === "Self")?.coverage_amount) || 0 : Number(d.sum_insured) || 0;

  function splitEvenly() {
    const n = nominees.length;
    if (!n) return;
    const each = Math.floor((100 / n) * 100) / 100;
    let left = Math.round((100 - each * n) * 100) / 100;
    setRows(rows.map((r) => { if (r.kind === "Self") return r; const extra = left > 0 ? left : 0; left = 0; return { ...r, share_pct: String(Math.round((each + extra) * 100) / 100) }; }));
  }
  const changeKind = (i: number, kind: MemberKind) => patchRow(i, { kind, relationship: kind === "Nominee" ? rows[i].relationship || "Child" : "", insured: kind === "Spouse" ? rows[i].insured : "" });

  const lbl = "text-xs font-semibold text-slate-600";
  const inp = (flag: boolean) => `input ${flag ? "!border-amber-400" : ""}`;
  const headers = [t("walkin.fam.member"), t("walkin.fam.relation"), t("walkin.fam.insured"), t("walkin.fam.name"), t("walkin.fam.cnic"), t("walkin.fam.dob"), t("walkin.f.gender"),
    t("walkin.f.occupation"), t("walkin.fam.income"), t("walkin.fam.smoker"), t("walkin.fam.ht"), t("walkin.fam.wt"), ...(bundle ? [t("walkin.fam.cover")] : []), t("walkin.fam.share"), t("walkin.fam.amount"), ""];

  return (
    <div className="card overflow-hidden">
      <div role="tablist" className="flex flex-wrap gap-x-1 border-b border-slate-100 px-3 pt-2">
        {FAMILY_TABS.map((k) => (
          <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`relative px-3 py-2.5 text-[13px] font-semibold border-b-2 -mb-px ${tab === k ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
            {k === "members" ? t("walkin.fam.tab.members", { count: rows.length }) : t(`walkin.fam.tab.${k}`)}
            {gaps[k].length > 0 && <span className="absolute top-1.5 end-0.5 w-1.5 h-1.5 rounded-full bg-amber-500" aria-label={t("walkin.apply.required")} />}
          </button>
        ))}
      </div>

      <div className="p-5 sm:p-6 space-y-4">
        {error && <Banner tone="danger" title={errorText(t, error)} />}

        {tab === "details" && (
          <div className="space-y-4 max-w-3xl">
            <Field label={t("walkin.fam.familyName") + " *"} htmlFor="fam_name"><input id="fam_name" className={inp(gaps.details.includes("family_name"))} value={d.family_name} onChange={(e) => set({ family_name: e.target.value })} placeholder={t("walkin.fam.familyNamePh")} maxLength={255} /></Field>
            <Field label={t("walkin.fam.contactPerson")} htmlFor="fam_person"><input id="fam_person" className="input" value={d.contact_person} onChange={(e) => set({ contact_person: e.target.value })} placeholder={t("walkin.fam.contactPersonPh")} maxLength={255} /></Field>
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label={t("walkin.fam.contactEmail")} htmlFor="fam_email" hint={t("walkin.apply.emailVerified")}><input id="fam_email" className="input bg-slate-50" dir="ltr" value={email} readOnly /></Field>
              <Field label={t("walkin.fam.contactPhone") + " *"} htmlFor="fam_phone"><input id="fam_phone" type="tel" className={inp(gaps.details.includes("contact_phone"))} dir="ltr" value={d.contact_phone} onChange={(e) => set({ contact_phone: e.target.value })} placeholder="+92 300 1234567" maxLength={30} /></Field>
            </div>
            <Field label={t("walkin.fam.householdIncome")} htmlFor="fam_income" hint={t("walkin.fam.householdIncomeHint")}><input id="fam_income" type="number" min={0} dir="ltr" className="input" value={d.household_income} onChange={(e) => set({ household_income: e.target.value })} placeholder="2400000" /></Field>
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label={t("walkin.f.city") + " *"} htmlFor="fam_city"><input id="fam_city" className={inp(gaps.details.includes("city"))} value={d.city} onChange={(e) => set({ city: e.target.value })} placeholder={t("walkin.fam.cityPh")} maxLength={100} /></Field>
              <Field label={t("walkin.f.province")} htmlFor="fam_prov">
                <select id="fam_prov" className="input" value={d.province} onChange={(e) => set({ province: e.target.value })}>
                  <option value="">{t("walkin.fam.selectProvince")}</option>{PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>
            </div>
          </div>
        )}

        {tab === "policy" && (
          <div className="space-y-4 max-w-3xl">
            <Field label={t("walkin.apply.plan") + " *"} htmlFor="fam_plan" hint={t("walkin.apply.planHint")}>
              {plansLoading ? <Skeleton className="h-10 w-full" /> : (
                <select id="fam_plan" className={inp(gaps.policy.includes("plan_id"))} value={d.plan_id} onChange={(e) => set({ plan_id: e.target.value })}>
                  <option value="">{t("walkin.apply.choosePlan")}</option>{familyPlans.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              )}
            </Field>
            {chosen && <p className="text-xs text-slate-500">{t("walkin.apply.planBand", { min: chosen.entry_age_min, max: chosen.entry_age_max, tmin: chosen.term_min_years, tmax: chosen.term_max_years })}</p>}
            <div className="grid sm:grid-cols-2 gap-3">
              {(["Floater", "LifeBundle"] as const).map((k) => (
                <button key={k} type="button" onClick={() => set({ kind: k })}
                  className={`text-start rounded-xl border p-4 transition-all ${d.kind === k ? "border-blue-600 bg-blue-50/50 ring-1 ring-blue-600" : "border-slate-200 hover:border-slate-300"}`}>
                  <p className="text-sm font-semibold text-slate-900">{t(`walkin.fam.kind.${k}`)}</p>
                  <p className="text-xs text-slate-500 mt-1">{t(`walkin.fam.kind.${k}Text`)}</p>
                </button>
              ))}
            </div>
            <div className="grid sm:grid-cols-3 gap-4">
              {bundle ? (
                <Field label={t("walkin.fam.discount")} htmlFor="fam_disc"><input id="fam_disc" type="number" className="input" value={d.discount} onChange={(e) => set({ discount: e.target.value })} /></Field>
              ) : (
                <Field label={t("walkin.fam.sumInsured") + " *"} htmlFor="fam_sum"><input id="fam_sum" type="number" min={0} dir="ltr" className={inp(gaps.policy.includes("sum_insured"))} value={d.sum_insured} onChange={(e) => set({ sum_insured: e.target.value })} /></Field>
              )}
              <Field label={t("walkin.fam.term") + " *"} htmlFor="fam_term"><input id="fam_term" type="number" min={1} dir="ltr" className={inp(gaps.policy.includes("term"))} value={d.term} onChange={(e) => set({ term: e.target.value })} /></Field>
              <Field label={t("walkin.fam.effective")} htmlFor="fam_eff"><input id="fam_eff" type="date" dir="ltr" className="input" value={d.effective} onChange={(e) => set({ effective: e.target.value })} /></Field>
            </div>
            <Field label={t("walkin.apply.contactPref")} htmlFor="fam_pref">
              <select id="fam_pref" className="input" value={d.preferred_contact} onChange={(e) => set({ preferred_contact: e.target.value })}>
                {CONTACT.map((c) => <option key={c} value={c}>{t(`walkin.contact.${c}`)}</option>)}
              </select>
            </Field>
            <Field label={t("walkin.apply.message")} htmlFor="fam_msg"><textarea id="fam_msg" className="input min-h-[80px]" value={d.message} onChange={(e) => set({ message: e.target.value })} maxLength={1000} /></Field>
            <label className="flex items-start gap-2.5 text-sm text-slate-700">
              <input type="checkbox" className="mt-1" checked={d.consent} onChange={(e) => set({ consent: e.target.checked })} /><span>{t("walkin.apply.consent")}</span>
            </label>
          </div>
        )}

        {tab === "members" && (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">{t("walkin.fam.membersHelp")}</p>
            <div className="overflow-x-auto border border-slate-100 rounded-lg">
              <table className="w-full text-xs table-auto">
                <thead>
                  <tr className="bg-slate-50 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    {headers.map((h, k) => <th key={`${h}${k}`} className="px-2 py-2 text-start whitespace-nowrap">{h}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r, i) => {
                    const ins = isInsured(r), off = !ins;
                    const amount = r.kind === "Self" ? null : (base * (Number(r.share_pct) || 0)) / 100;
                    return (
                      <tr key={i} className={off ? "bg-slate-50/40" : ""}>
                        <td className="px-1.5 py-1.5 min-w-[92px]">
                          {r.kind === "Self" ? <span className="font-semibold text-slate-700 px-1">{t("walkin.fam.head")}</span> : (
                            <select className={cell(i, "kind")} value={r.kind} onChange={(e) => changeKind(i, e.target.value as MemberKind)}>
                              <option value="Spouse">{t("walkin.o.Spouse")}</option><option value="Nominee">{t("walkin.fam.nominee")}</option>
                            </select>
                          )}
                        </td>
                        <td className="px-1.5 py-1.5 min-w-[84px]">
                          {r.kind === "Nominee" ? (
                            <select className={cell(i, "relationship")} value={r.relationship} onChange={(e) => patchRow(i, { relationship: e.target.value })}>
                              {NOMINEE_RELATIONSHIPS.map((o) => <option key={o} value={o}>{t(`walkin.o.${optionKey(o)}`)}</option>)}
                            </select>
                          ) : <span className="text-slate-300 px-1">—</span>}
                        </td>
                        <td className="px-1.5 py-1.5 min-w-[92px]">
                          {r.kind === "Spouse" ? (
                            <select className={cell(i, "insured")} value={r.insured} onChange={(e) => patchRow(i, { insured: e.target.value as FamilyRow["insured"] })}>
                              <option value="">{t("walkin.fam.select")}</option><option value="yes">{t("walkin.fam.yes")}</option><option value="no">{t("walkin.fam.no")}</option>
                            </select>
                          ) : <span className="text-slate-400 px-1">{r.kind === "Self" ? t("walkin.fam.yes") : t("walkin.fam.no")}</span>}
                        </td>
                        <td className="px-1.5 py-1.5 min-w-[130px]"><input className={cell(i, "name")} value={r.name} onChange={(e) => patchRow(i, { name: e.target.value })} maxLength={255} /></td>
                        <td className="px-1.5 py-1.5 min-w-[130px]"><input className={cell(i, "cnic")} dir="ltr" value={r.cnic} onChange={(e) => patchRow(i, { cnic: e.target.value })} placeholder="35201-1234567-1" maxLength={15} disabled={off} /></td>
                        <td className="px-1.5 py-1.5 min-w-[118px]"><input type="date" className={cell(i, "dob")} dir="ltr" value={r.dob} max={new Date().toISOString().slice(0, 10)} onChange={(e) => patchRow(i, { dob: e.target.value })} /></td>
                        <td className="px-1.5 py-1.5 min-w-[84px]">
                          <select className={cell(i, "gender")} value={r.gender} onChange={(e) => patchRow(i, { gender: e.target.value })}>
                            <option value="">—</option>{["Male", "Female", "Other"].map((g) => <option key={g} value={g}>{t(`walkin.o.${g}`)}</option>)}
                          </select>
                        </td>
                        <td className="px-1.5 py-1.5 min-w-[110px]"><input className={cell(i, "occupation")} value={r.occupation} onChange={(e) => patchRow(i, { occupation: e.target.value })} disabled={off} /></td>
                        <td className="px-1.5 py-1.5 min-w-[96px]"><input type="number" min={0} dir="ltr" className={cell(i, "declared_income")} value={r.declared_income} onChange={(e) => patchRow(i, { declared_income: e.target.value })} disabled={off} /></td>
                        <td className="px-1.5 py-1.5 min-w-[76px]">
                          <select className={cell(i, "is_smoker")} value={r.is_smoker} onChange={(e) => patchRow(i, { is_smoker: e.target.value as FamilyRow["is_smoker"] })} disabled={off}>
                            <option value="">—</option><option value="false">{t("walkin.fam.no")}</option><option value="true">{t("walkin.fam.yes")}</option>
                          </select>
                        </td>
                        <td className="px-1.5 py-1.5 w-[64px]"><input type="number" min={0} dir="ltr" className={cell(i, "height_cm")} value={r.height_cm} onChange={(e) => patchRow(i, { height_cm: e.target.value })} disabled={off} /></td>
                        <td className="px-1.5 py-1.5 w-[64px]"><input type="number" min={0} dir="ltr" className={cell(i, "weight_kg")} value={r.weight_kg} onChange={(e) => patchRow(i, { weight_kg: e.target.value })} disabled={off} /></td>
                        {bundle && <td className="px-1.5 py-1.5 min-w-[100px]"><input type="number" min={0} dir="ltr" className={cell(i, "coverage_amount")} value={r.coverage_amount} onChange={(e) => patchRow(i, { coverage_amount: e.target.value })} disabled={off} /></td>}
                        <td className="px-1.5 py-1.5 w-[72px]">{r.kind === "Self" ? <span className="text-slate-300 px-1">—</span> : <input type="number" min={0} max={100} dir="ltr" className={cell(i, "share_pct")} value={r.share_pct} onChange={(e) => patchRow(i, { share_pct: e.target.value })} />}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap text-slate-500 tabular-nums">{amount === null ? "—" : pkr(amount)}</td>
                        <td className="px-1.5 py-1.5">{r.kind !== "Self" && <button type="button" className="text-slate-300 hover:text-rose-500" aria-label={t("walkin.family.remove")} onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {rows.length < 8 && <button type="button" className="btn-secondary" onClick={() => setRows([...rows, blankRow("Nominee")])}>{t("walkin.family.addMember")}</button>}
              {nominees.length > 1 && <button type="button" className="btn-secondary" onClick={splitEvenly}>{t("walkin.family.split")}</button>}
              <span className={`ms-auto text-xs font-semibold ${nominees.length === 0 || Math.abs(total - 100) <= 0.01 ? "text-slate-500" : "text-amber-700"}`}>{t("walkin.family.total", { total })}</span>
            </div>
            {gaps.members.filter((g) => !g.startsWith("row.")).map((g) => <p key={g} className="text-xs text-amber-700">{t(`walkin.fam.gap.${g}`)}</p>)}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-3">
        <button type="button" className="btn-secondary" disabled={idx === 0} onClick={() => setTab(FAMILY_TABS[idx - 1])}>{t("common.back")}</button>
        <div className="flex items-center gap-2">
          {idx < FAMILY_TABS.length - 1 && <button type="button" className="btn-secondary" onClick={() => setTab(FAMILY_TABS[idx + 1])}>{t("walkin.apply.next")}</button>}
          <button type="button" className="btn-primary" disabled={!valid || busy} onClick={() => onSubmit({ applicant_type: "Family", family: buildFamily(d, rows), plan_id: d.plan_id, preferred_contact: d.preferred_contact, message: d.message.trim() || undefined, consent: d.consent })}
            title={valid ? undefined : t("walkin.apply.completeRequired")}>{busy ? <><Spinner />{t("common.submitting")}</> : t("walkin.apply.submit")}</button>
        </div>
      </div>
      {!valid && <p className="px-5 pb-3 -mt-1 text-xs text-slate-500">{t("walkin.apply.completeRequired")}</p>}
    </div>
  );
}
