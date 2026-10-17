"use client";

import type { ReactNode } from "react";
import { tx } from "@/lib/i18n/tx";
import { fmtCoverage } from "@/lib/mock-data";
import { displayDate } from "@/lib/dateDisplay";

type Evidence = Record<string, unknown>;
type Props = {
  track: "medical" | "financial"; evidence: Evidence; customerName: string; cnic: string | null;
  productName: string | null; coverage: number | null; termYears: number | null; openedAt: string;
};
type Flag = { title: string; detail: string };
type Obj = Record<string, any>;

const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Obj : null);
const num = (v: unknown): number | null => { const n = typeof v === "number" ? v : parseFloat(String(v ?? "")); return Number.isFinite(n) ? n : null; };
const filled = (v: unknown) => v !== null && v !== undefined && v !== "";
const money = (n: number | null) => n == null ? null : n >= 100_000 ? fmtCoverage(n) : `PKR ${n.toLocaleString()}`;
function ageFrom(dob: unknown): number | null {
  const d = new Date(String(dob ?? "")); if (Number.isNaN(d.getTime())) return null;
  const now = new Date(); let age = now.getFullYear() - d.getFullYear();
  if (now < new Date(now.getFullYear(), d.getMonth(), d.getDate())) age -= 1;
  return age;
}

// ── Layout primitives ────────────────────────────────────────────────────────

function Card({ title, subtitle, action, children, className = "" }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`}>
    <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3.5"><div><h3 className="text-sm font-semibold text-slate-900">{tx(title)}</h3>{subtitle && <p className="mt-0.5 text-xs text-slate-500">{tx(subtitle)}</p>}</div>{action}</header>
    <div className="p-5">{children}</div>
  </section>;
}
function Fact({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: string }) {
  return <div className="min-w-0"><dt className="text-xs text-slate-500">{tx(label)}</dt><dd className={`mt-0.5 truncate text-sm font-semibold ${tone ?? "text-slate-900"}`}>{filled(value) ? value : <span className="font-normal text-slate-400">{tx("Not provided")}</span>}</dd>{hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}</div>;
}
function Pill({ yes, yesText = "Yes", noText = "No", bad = true }: { yes: boolean | null | undefined; yesText?: string; noText?: string; bad?: boolean }) {
  if (yes == null) return <span className="text-xs text-slate-400">—</span>;
  const tone = yes ? (bad ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200") : "bg-slate-100 text-slate-600 ring-slate-200";
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${tone}`}>{tx(yes ? yesText : noText)}</span>;
}
function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-slate-200 px-4 py-5 text-center text-sm text-slate-500">{children}</p>;
}
function Timeline({ items }: { items: Obj[] }) {
  return <ol className="relative space-y-4 border-s border-slate-200 ps-5">{items.map((h, i) => <li key={i} className="relative"><span className="absolute -start-[25px] top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-blue-500 ring-1 ring-blue-200" />
    <p className="text-xs font-medium text-slate-500">{h.date || tx("Date not given")}{h.duration ? ` · ${h.duration}` : ""}</p>
    <p className="text-sm font-semibold text-slate-900">{h.reason_or_type || tx("Not described")}</p>{h.hospital && <p className="text-xs text-slate-500">{h.hospital}</p>}</li>)}</ol>;
}

// ── Consistency checks: what the declarations say against each other ─────────

function financialFlags(e: Evidence, coverage: number | null): Flag[] {
  const flags: Flag[] = [];
  const declared = num(e["Declared income (PKR)"]);
  const existing = obj(e["Existing insurance"]);
  const acr = obj(e["Agent income verification"]);
  const fp = obj(e["Financial e-application"]);
  const stated = num(fp?.income?.annual_income);
  if (declared && stated && Math.abs(declared - stated) / Math.max(declared, stated) > 0.15)
    flags.push({ title: "Income doesn't match", detail: `${tx("Profile declares")} ${money(declared)}; ${tx("financial e-application states")} ${money(stated)}.` });
  const occupation = String(e["Occupation"] ?? "").trim().toLowerCase();
  const statedOccupation = String(fp?.employment?.occupation ?? "").trim();
  if (occupation && statedOccupation && !statedOccupation.toLowerCase().includes(occupation) && !occupation.includes(statedOccupation.toLowerCase()))
    flags.push({ title: "Occupation differs", detail: `${tx("Profile")}: ${e["Occupation"]}. ${tx("E-application")}: ${statedOccupation}.` });
  const repayments = num(fp?.commitments?.monthly_loan_repayments);
  const monthly = (stated ?? declared) ? (stated ?? declared)! / 12 : null;
  if (repayments && monthly && repayments / monthly > 0.4)
    flags.push({ title: "High debt repayments", detail: `${Math.round(repayments / monthly * 100)}% ${tx("of monthly income goes to loan repayments.")}` });
  if (fp?.funding?.premium_payer && fp.funding.premium_payer !== "Myself")
    flags.push({ title: "Premium paid by someone else", detail: `${tx("Payer")}: ${fp.funding.premium_payer}${fp.funding.premium_source ? ` · ${fp.funding.premium_source}` : ""}. ${tx("Check insurable interest.")}` });
  if (existing?.was_declined_or_deferred) flags.push({ title: "Previously declined or deferred", detail: existing.declined_details || tx("No details given.") });
  if (existing?.applied_last_2_years) flags.push({ title: "Applied elsewhere recently", detail: tx("The customer applied for life cover with another insurer in the last 2 years.") });
  if (declared && coverage && coverage / declared > 20) flags.push({ title: "High cover-to-income multiple", detail: `${(coverage / declared).toFixed(1)}× ${tx("annual income")}.` });
  if (acr && (acr["Occupation verified"] === false || acr["Income source verified"] === false))
    flags.push({ title: "Agent could not verify income", detail: tx("The agent confidential report leaves the occupation or income source unverified.") });
  return flags;
}

function medicalFlags(e: Evidence): Flag[] {
  const flags: Flag[] = [];
  const mq = obj(e["Medical questionnaire"]);
  if (!mq) return flags;
  if (e["Smoker"] === true && mq.tobacco_use === false)
    flags.push({ title: "Smoking status conflicts", detail: tx("The profile records a smoker; the e-application declares no tobacco use.") });
  if (e["Smoker"] === false && mq.tobacco_use === true)
    flags.push({ title: "Smoking status conflicts", detail: tx("The e-application declares tobacco use; the profile records a non-smoker.") });
  const ph = num(e["Height (cm)"]), pw = num(e["Weight (kg)"]), qh = num(mq.height_cm), qw = num(mq.weight_kg);
  if (ph && qh && Math.abs(ph - qh) >= 3) flags.push({ title: "Height differs", detail: `${tx("Profile")} ${ph} cm · ${tx("e-application")} ${qh} cm.` });
  if (pw && qw && Math.abs(pw - qw) >= 3) flags.push({ title: "Weight differs", detail: `${tx("Profile")} ${pw} kg · ${tx("e-application")} ${qw} kg.` });
  const untreated = (Array.isArray(mq.conditions) ? mq.conditions : []).filter((c: Obj) => c.checked && !c.under_treatment);
  if (untreated.length) flags.push({ title: "Declared condition not under treatment", detail: untreated.map((c: Obj) => c.label).join(", ") });
  return flags;
}

function Consistency({ flags }: { flags: Flag[] }) {
  return <Card title="Consistency checks" subtitle="The customer profile compared with the e-application questionnaire"
    action={<span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${flags.length ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-700"}`}>{flags.length ? `${flags.length} ${tx(flags.length === 1 ? "to check" : "to check")}` : tx("Consistent")}</span>}>
    {flags.length ? <ul className="space-y-2.5">{flags.map((f) => <li key={f.title} className="flex gap-3 rounded-xl bg-amber-50/60 p-3 ring-1 ring-inset ring-amber-100">
      <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-amber-500 text-[11px] font-bold text-white">!</span>
      <div className="min-w-0"><p className="text-sm font-semibold text-slate-900">{tx(f.title)}</p><p className="mt-0.5 text-xs leading-5 text-slate-600">{f.detail}</p></div></li>)}</ul>
      : <p className="text-sm text-slate-500">{tx("No contradictions found between the declarations on file. This is a prompt, not a clearance.")}</p>}
  </Card>;
}

// ── Track sections ───────────────────────────────────────────────────────────

function MedicalSections({ e }: { e: Evidence }) {
  const mq = obj(e["Medical questionnaire"]);
  const h = num(e["Height (cm)"]) ?? num(mq?.height_cm), w = num(e["Weight (kg)"]) ?? num(mq?.weight_kg);
  const bmi = h && w ? w / (h / 100) ** 2 : null;
  const bmiBand = bmi == null ? null : bmi < 18.5 ? ["Underweight", "text-amber-600"] : bmi < 25 ? ["Healthy", "text-emerald-600"] : bmi < 30 ? ["Overweight", "text-amber-600"] : ["Obese", "text-rose-600"];
  const conditions: Obj[] = Array.isArray(mq?.conditions) ? mq!.conditions : [];
  const declared = conditions.filter((c) => c.checked);
  const history = [...(mq?.surgeries ?? []).map((s: Obj) => ({ ...s, kind: "Surgery" })), ...(mq?.hospitalizations ?? []).map((s: Obj) => ({ ...s, kind: "Hospital stay" }))];
  const disclosures = Object.entries(obj(mq?.disclosures) ?? {});
  const family: Obj[] = obj(e["Family medical history"])?.entries ?? [];
  const tests: Obj[] = Array.isArray(e["Required tests"]) ? e["Required tests"] as Obj[] : [];
  const findings = Object.entries(obj(e["Medical findings"]) ?? {});
  return <div className="grid gap-5 xl:grid-cols-12">
    <div className="space-y-5 xl:col-span-8">
      <Card title="Declared conditions" subtitle={`${declared.length} ${tx("of")} ${conditions.length || "—"} ${tx("conditions declared on the e-application")}`}>
        {!mq ? <Empty>{tx("The customer hasn't submitted the e-application yet.")}</Empty>
          : declared.length ? <div className="grid gap-3 md:grid-cols-2">{declared.map((c) => <article key={c.key} className="rounded-xl border border-amber-200 bg-amber-50/40 p-4">
            <div className="flex items-start justify-between gap-2"><h4 className="text-sm font-semibold text-slate-900">{c.label}</h4>{c.under_treatment && <span className="whitespace-nowrap rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200">{tx("Under treatment")}</span>}</div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">{[["Diagnosed", c.year_of_diagnosis], ["Last consultation", c.last_consultation_date], ["Medication", c.medications], ["Physician", [c.physician_name, c.physician_clinic].filter(Boolean).join(", ")]].map(([k, v]) => <div key={k} className={k === "Medication" || k === "Physician" ? "col-span-2" : ""}><dt className="text-slate-500">{tx(k)}</dt><dd className="font-medium text-slate-800">{v || "—"}</dd></div>)}</dl>
          </article>)}</div> : <p className="text-sm text-slate-600">{tx("No medical conditions declared.")}</p>}
      </Card>
      <div className="grid gap-5 md:grid-cols-2">
        <Card title="Surgeries & hospital stays">{history.length ? <Timeline items={history.map((x) => ({ ...x, reason_or_type: `${x.reason_or_type || ""} · ${tx(x.kind)}` }))} /> : <p className="text-sm text-slate-500">{tx(mq ? "None declared." : "Awaiting the e-application.")}</p>}</Card>
        <Card title="Family medical history">{family.length ? <ul className="divide-y divide-slate-100">{family.map((f, i) => <li key={i} className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0"><div><p className="text-sm font-semibold text-slate-900">{f.relation}<span className="font-normal text-slate-500"> · {f.is_alive === false ? tx("Deceased") : `${f.age ?? "—"} ${tx("yrs")}`}</span></p><p className="text-xs text-slate-500">{f.name}</p></div><div className="text-end"><p className="text-sm text-slate-800">{f.condition || tx("No condition")}</p>{f.age_at_onset && <p className="text-xs text-slate-500">{tx("Onset at")} {f.age_at_onset}</p>}</div></li>)}</ul> : <p className="text-sm text-slate-500">{tx("No family history recorded.")}</p>}</Card>
      </div>
      <Card title="Examination findings" subtitle={String(e["Medical examination"] ?? "") ? `${tx("Examination")}: ${e["Medical examination"]}` : undefined}>
        {findings.length ? <div className="grid grid-cols-2 gap-3 md:grid-cols-3">{findings.map(([code, value]) => { const t = tests.find((x) => x.code === code); return <div key={code} className="rounded-xl border border-slate-100 bg-slate-50/60 p-3"><p className="truncate text-xs text-slate-500" title={t?.name}>{t?.name ?? code}</p><p className="mt-1 text-sm font-semibold text-slate-900">{String(value)}</p><p className="mt-0.5 text-[11px] text-slate-400">{t?.category ?? code}</p></div>; })}</div>
          : tests.length ? <div className="flex flex-wrap gap-1.5">{tests.map((t) => <span key={t.code} className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">{t.name}</span>)}</div>
          : <Empty>{tx("No examination has been ordered or recorded.")}</Empty>}
      </Card>
    </div>
    <div className="space-y-5 xl:col-span-4">
      <Card title="Build & lifestyle">
        <dl className="grid grid-cols-2 gap-4"><Fact label="Height" value={h ? `${h} cm` : null} /><Fact label="Weight" value={w ? `${w} kg` : null} />
          <Fact label="BMI" value={bmi ? bmi.toFixed(1) : null} hint={bmiBand && tx(bmiBand[0])} tone={bmiBand?.[1]} /><Fact label="Smoker (profile)" value={<Pill yes={e["Smoker"] as boolean | null} />} /></dl>
        <ul className="mt-4 divide-y divide-slate-100 border-t border-slate-100">{[["Tobacco", mq?.tobacco_use, mq?.tobacco_frequency], ["Alcohol", mq?.alcohol_use, mq?.alcohol_units_per_week && `${mq.alcohol_units_per_week} ${tx("units/week")}`], ["Recreational drugs", mq?.drug_use, mq?.drug_use_details]].map(([k, v, detail]) => <li key={k as string} className="flex items-center justify-between gap-3 py-2.5 text-sm"><span className="text-slate-600">{tx(k as string)}{detail ? <span className="block text-xs text-slate-400">{detail}</span> : null}</span><Pill yes={mq ? Boolean(v) : null} /></li>)}</ul>
      </Card>
      {disclosures.length > 0 && <Card title="Other disclosures"><ul className="space-y-2.5">{disclosures.map(([k, v]) => { const a = obj(v); const yes = String(a?.answer ?? v).toLowerCase() === "yes"; return <li key={k} className="text-sm"><div className="flex items-center justify-between gap-3"><span className="capitalize text-slate-600">{k.replace(/_/g, " ")}</span><Pill yes={yes} /></div>{a?.details && <p className="mt-1 text-xs text-slate-500">{a.details}</p>}</li>; })}</ul></Card>}
    </div>
  </div>;
}

function FinancialAnswers({ fp }: { fp: Obj | null }) {
  if (!fp) return <Card title="Financial e-application"><Empty>{tx("The customer hasn't submitted the financial e-application yet.")}</Empty></Card>;
  const { employment = {}, income = {}, commitments = {}, assets = {}, funding = {} } = fp;
  const groups: [string, [string, ReactNode][]][] = [
    ["Employment", [["Type", employment.employment_type], ["Occupation", employment.occupation], ["Employer / business", employment.employer_or_business], ["Years in role", employment.years_in_role]]],
    ["Income", [["Annual income", money(num(income.annual_income)) && `${money(num(income.annual_income))} · ${tx(income.income_basis || "Gross")}`], ["Other income", income.other_income_sources ? `${income.other_income_sources}${income.other_income_amount ? ` · ${money(num(income.other_income_amount))}` : ""}` : tx("None")]]],
    ["Commitments", [["Monthly household expenses", money(num(commitments.monthly_household_expenses))], ["Dependants", commitments.dependants], ["Loans or debts", commitments.has_loans ? `${commitments.loan_details || tx("Yes")}${commitments.monthly_loan_repayments ? ` · ${money(num(commitments.monthly_loan_repayments))}/${tx("month")}` : ""}` : tx("None")]]],
    ["Assets", [["Savings & investments", money(num(assets.savings_and_investments))], ["Property", assets.owns_property ? assets.property_details || tx("Yes") : tx("None")], ["Other assets", assets.other_assets || tx("None")]]],
    ["Premium & purpose", [["Paid by", funding.premium_payer], ["Source", funding.premium_source], ["Purpose of cover", funding.purpose_of_cover], ["Notes", funding.purpose_details || null]]],
  ];
  return <Card title="Financial e-application" subtitle="As declared by the customer">
    <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">{groups.map(([title, rows]) => <div key={title}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{tx(title)}</p>
      <dl className="mt-2 divide-y divide-slate-100">{rows.filter(([, v]) => v !== null).map(([k, v]) => <div key={k} className="flex items-baseline justify-between gap-4 py-1.5 text-sm"><dt className="text-slate-500">{tx(k)}</dt><dd className="text-end font-medium text-slate-900">{filled(v) ? v : <span className="font-normal text-slate-400">—</span>}</dd></div>)}</dl>
    </div>)}</div>
  </Card>;
}

function FinancialSections({ e, coverage }: { e: Evidence; coverage: number | null }) {
  const income = num(e["Declared income (PKR)"]);
  const premium = num(e["Quoted premium (PKR)"]);
  const acr = obj(e["Agent income verification"]);
  const existing = obj(e["Existing insurance"]);
  const policies: Obj[] = existing?.policies ?? [];
  const existingCover = policies.reduce((sum, p) => sum + (num(p.sum_assured) ?? 0), 0);
  const multiple = income && coverage ? coverage / income : null;
  const affordability = income && premium ? premium / income * 100 : null;
  return <div className="grid gap-5 xl:grid-cols-12">
    <div className="space-y-5 xl:col-span-8">
      <Card title="Income & affordability">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Fact label="Declared income" value={money(income)} hint={tx("per year")} />
          <Fact label="Occupation" value={e["Occupation"] as string} />
          <Fact label="Cover ÷ income" value={multiple ? `${multiple.toFixed(1)}×` : null} tone={multiple == null ? undefined : multiple > 20 ? "text-rose-600" : multiple > 12 ? "text-amber-600" : "text-emerald-600"} hint={tx("sum assured to annual income")} />
          <Fact label="Premium ÷ income" value={affordability != null ? `${affordability.toFixed(1)}%` : null} tone={affordability == null ? undefined : affordability > 15 ? "text-rose-600" : affordability > 8 ? "text-amber-600" : "text-emerald-600"} hint={premium ? `${money(premium)} ${tx("a year")}` : tx("No quote yet")} />
        </dl>
      </Card>
      <FinancialAnswers fp={obj(e["Financial e-application"])} />
      <Card title="Existing & previous insurance" subtitle={existing ? undefined : "From the customer e-application"}
        action={policies.length ? <span className="text-xs font-semibold text-slate-500">{tx("Existing cover")} {money(existingCover)}</span> : undefined}>
        {!existing ? <Empty>{tx("The customer hasn't submitted the e-application yet.")}</Empty> : <>
          {policies.length ? <div className="overflow-x-auto rounded-xl border border-slate-100"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr>{["Insurer", "Policy number", "Sum assured", "Status"].map((h) => <th key={h} className="px-4 py-2 font-medium">{tx(h)}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">{policies.map((p, i) => <tr key={i}><td className="px-4 py-3 font-medium text-slate-900">{p.insurer_name || "—"}</td><td className="px-4 py-3 font-mono text-xs text-slate-600">{p.policy_number || "—"}</td><td className="px-4 py-3 tabular-nums">{money(num(p.sum_assured)) ?? "—"}</td><td className="px-4 py-3"><span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{p.status || "—"}</span></td></tr>)}</tbody></table></div>
            : <p className="text-sm text-slate-600">{tx("No existing policies declared.")}</p>}
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            <li className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3 text-sm"><span className="text-slate-600">{tx("Applied elsewhere in the last 2 years")}</span><Pill yes={existing.applied_last_2_years} /></li>
            <li className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3 text-sm"><span className="text-slate-600">{tx("Ever declined or deferred")}</span><Pill yes={existing.was_declined_or_deferred} /></li>
          </ul>
          {existing.declined_details && <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{existing.declined_details}</p>}
        </>}
      </Card>
    </div>
    <div className="space-y-5 xl:col-span-4">
      <Card title="Agent income verification" subtitle="Agent confidential report">
        {acr ? <ul className="space-y-3 text-sm">
          <li className="flex items-center justify-between"><span className="text-slate-600">{tx("Occupation verified")}</span><Pill yes={acr["Occupation verified"]} yesText="Verified" noText="Not verified" bad={false} /></li>
          <li className="flex items-center justify-between"><span className="text-slate-600">{tx("Income source verified")}</span><Pill yes={acr["Income source verified"]} yesText="Verified" noText="Not verified" bad={false} /></li>
          {acr["Estimated income opinion"] && <li><p className="text-xs text-slate-500">{tx("Agent's income estimate")}</p><p className="mt-0.5 text-slate-800">{String(acr["Estimated income opinion"])}</p></li>}
          {acr["Income consistency"] && <li><p className="text-xs text-slate-500">{tx("Consistency note")}</p><p className="mt-0.5 text-slate-800">{String(acr["Income consistency"])}</p></li>}
        </ul> : <Empty>{tx("No agent confidential report on file. Income is unverified by the agent.")}</Empty>}
      </Card>
    </div>
  </div>;
}

export default function ApplicantPolicyTab({ track, evidence, customerName, cnic, productName, coverage, termYears, openedAt }: Props) {
  const e = evidence;
  const flags = track === "medical" ? medicalFlags(e) : financialFlags(e, coverage);
  const age = ageFrom(e["Date of birth"]);
  const sumAssured = num(e["Sum assured (PKR)"]) ?? coverage;
  const premium = num(e["Quoted premium (PKR)"]);
  return <div className="space-y-5">
    <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
      <Card title="Applicant">
        <div className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 text-sm font-bold text-white">{customerName.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</span><div className="min-w-0"><p className="truncate font-semibold text-slate-900">{customerName}</p><p className="font-mono text-xs text-slate-500">{cnic ?? tx("CNIC not recorded")}</p></div></div>
        <dl className="mt-4 grid grid-cols-2 gap-4">{track === "medical"
          ? <><Fact label="Age" value={age != null ? `${age} ${tx("yrs")}` : null} hint={filled(e["Date of birth"]) ? displayDate(String(e["Date of birth"])) : undefined} /><Fact label="Smoker" value={<Pill yes={e["Smoker"] as boolean | null} />} /></>
          : <><Fact label="Occupation" value={e["Occupation"] as string} /><Fact label="Declared income" value={money(num(e["Declared income (PKR)"]))} hint={tx("per year")} /></>}</dl>
      </Card>
      <Card title="Proposed policy">
        <p className="text-base font-semibold text-slate-900">{productName ?? <span className="text-slate-400">{tx("No proposal linked")}</span>}</p>
        <dl className="mt-4 grid grid-cols-3 gap-4"><Fact label="Sum assured" value={money(sumAssured)} /><Fact label="Term" value={termYears ? `${termYears} ${tx("yrs")}` : null} /><Fact label="Premium" value={money(premium)} hint={premium ? tx("per year") : undefined} /></dl>
        <p className="mt-4 text-[11px] text-slate-400">{tx("Application opened")} {displayDate(openedAt)}</p>
      </Card>
      <div className="lg:col-span-2 xl:col-span-1"><Consistency flags={flags} /></div>
    </div>
    {track === "medical" ? <MedicalSections e={e} /> : <FinancialSections e={e} coverage={sumAssured} />}
  </div>;
}
