"use client";

import { useEffect, useRef, type FormEvent, type ReactNode } from "react";
import type { CreateClaimRequest } from "@/app/services/claims";
import type { PolicyDetail, PolicyListItem } from "@/app/services/policies";
import { formatCnic } from "@/lib/cnic";
import { tx } from "@/lib/i18n/tx";
import { PolicyPicker, type PolicyFilters } from "@/components/claims/PolicyPicker";

export type ClaimantType = "SELF" | "NOMINEE_BENEFICIARY" | "LEGAL_HEIR" | "GUARDIAN";

const STEPS = [
  { label: "Policy", title: "Select the policy", help: "Find the policy this claim is being made against, then continue." },
  { label: "Claim details", title: "What happened?", help: "Choose the type of claim, enter the amount and the date of the incident." },
  { label: "Claimant", title: "Who is making the claim?", help: "Tell us whether the policyholder or someone on their behalf is claiming." },
  { label: "Review", title: "Review and submit", help: "Check the details below. You can edit any section before submitting." },
] as const;
const LAST = STEPS.length;

const RELATIONSHIPS = ["Spouse", "Child", "Parent", "Legal Heir", "Executor"];

const inputClass =
  "w-full h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder-slate-400 focus:outline-hidden focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:bg-slate-50 disabled:text-slate-400";

const fmtPKR = (n: number) => `PKR ${(n || 0).toLocaleString()}`;
const fmtDate = (s?: string) =>
  s ? new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const titleCase = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

function Field({
  label, hint, error, optional, children,
}: { label: string; hint?: ReactNode; error?: string | null; optional?: boolean; children: ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-700 mb-1.5">
        {label}
        {optional && <span className="ml-1 font-normal text-slate-400">({tx("optional")})</span>}
      </label>
      {children}
      {error ? (
        <p className="mt-1.5 text-[11px] font-medium text-red-600">{error}</p>
      ) : hint ? (
        <p className="mt-1.5 text-[11px] text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

function Check({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function ReviewCard({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100">
        <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{title}</h4>
        <button type="button" onClick={onEdit} className="text-xs font-semibold text-blue-700 hover:underline">
          {tx("Edit")}
        </button>
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 px-4 py-3.5 text-sm">{children}</dl>
    </section>
  );
}

function Row({ label, value, wide }: { label: string; value: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className="font-semibold text-slate-900 break-words">{value || "—"}</dd>
    </div>
  );
}

export interface FnolWizardProps {
  step: number;
  setStep: (n: number) => void;
  onClose: () => void;

  policies: PolicyListItem[];
  policyFilters: PolicyFilters;
  selectedPolicy?: PolicyListItem;
  selectedPolicyDetail: PolicyDetail | null;
  onSelectPolicy: (p: PolicyListItem) => void;

  eligibleClaimTypes: string[];
  form: CreateClaimRequest;
  setForm: (f: CreateClaimRequest) => void;

  claimantType: ClaimantType;
  setClaimantType: (t: ClaimantType) => void;
  claimantName: string;
  setClaimantName: (v: string) => void;
  claimantCnic: string;
  setClaimantCnic: (v: string) => void;
  claimantRelationship: string;
  setClaimantRelationship: (v: string) => void;
  claimantPhone: string;
  setClaimantPhone: (v: string) => void;

  errorMsg: string;
  setErrorMsg: (v: string) => void;
  submitting: boolean;
  onSubmit: (e: FormEvent) => void;
}

export function FnolWizard(p: FnolWizardProps) {
  const {
    step, setStep, form, setForm, selectedPolicy, selectedPolicyDetail,
    claimantType, claimantName, claimantCnic, claimantRelationship, claimantPhone,
  } = p;
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => bodyRef.current?.scrollTo({ top: 0 }), [step]);

  const today = new Date().toISOString().split("T")[0];
  const limit = selectedPolicy?.coverage_amount ?? 0;
  const isDeath = form.claim_type.includes("Death");
  const amount = form.submitted_amount || 0;
  const meta = STEPS[step - 1];

  // The first thing still missing on a step — it blocks Continue and is shown beside the button.
  const issue = (n: number): string | null => {
    if (n === 1) return form.policy_id ? null : tx("Select a policy to continue.");
    if (n === 2) {
      if (!form.claim_type) return tx("Choose the claim type.");
      if (!(amount > 0)) return tx("Enter the claim amount.");
      if (limit && amount > limit) return tx("The amount is above the policy's coverage limit.");
      if (!form.incident_date) return tx("Enter the incident date.");
      if (form.incident_date > today) return tx("The incident date can't be in the future.");
      return null;
    }
    if (n === 3 && claimantType !== "SELF") {
      if (!claimantName.trim()) return tx("Enter the claimant's full name.");
      if (claimantCnic && claimantCnic.length < 15) return tx("Enter the complete CNIC, or leave it blank.");
    }
    return null;
  };
  const blocking = issue(step);

  const goNext = () => {
    const problem = issue(step);
    if (problem) {
      p.setErrorMsg(problem);
      return;
    }
    p.setErrorMsg("");
    p.setStep(Math.min(step + 1, LAST));
  };
  const goTo = (n: number) => {
    p.setErrorMsg("");
    p.setStep(n);
  };

  const onClaimTypeChange = (newType: string) => {
    setForm({ ...form, claim_type: newType });
    if (newType.includes("Death")) {
      p.setClaimantType("NOMINEE_BENEFICIARY");
      if (selectedPolicyDetail?.nominee_name && !claimantName) {
        p.setClaimantName(selectedPolicyDetail.nominee_name);
        p.setClaimantRelationship(selectedPolicyDetail.nominee_relationship || "Spouse");
      }
    } else {
      p.setClaimantType("SELF");
    }
  };
  const fillFromNominee = () => {
    p.setClaimantName(selectedPolicyDetail?.nominee_name || "");
    p.setClaimantRelationship(selectedPolicyDetail?.nominee_relationship || "Spouse");
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault(); // Enter inside a field moves on; only the Review step actually submits
    if (step < LAST) goNext();
    else p.onSubmit(e);
  };

  const amountError = limit && amount > limit ? tx("This is above the policy's coverage limit of {0}.", { 0: fmtPKR(limit) }) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4 overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="fnol-title"
        className={`relative my-auto flex w-full max-h-[92vh] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl transition-[max-width] ${
          step === 1 ? "max-w-4xl" : "max-w-3xl"
        }`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 bg-blue-600 px-6 py-4 text-white">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-blue-100">{tx("File a claim · First Notice of Loss")}</p>
            <h3 id="fnol-title" className="text-lg font-bold leading-tight">{tx(meta.title)}</h3>
          </div>
          <button
            type="button"
            onClick={p.onClose}
            aria-label={tx("Close")}
            className="-mr-1 flex h-8 w-8 items-center justify-center rounded-lg text-blue-100 hover:bg-blue-500 hover:text-white"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Progress */}
        <nav aria-label={tx("Progress")} className="border-b border-slate-100 bg-white px-6 py-4">
          <ol className="flex items-center">
            {STEPS.map((s, i) => {
              const n = i + 1;
              const done = step > n;
              const current = step === n;
              return (
                <li key={s.label} className={`flex items-center ${i < STEPS.length - 1 ? "flex-1" : ""}`}>
                  <button
                    type="button"
                    disabled={!done}
                    onClick={() => goTo(n)}
                    aria-current={current ? "step" : undefined}
                    className="flex items-center gap-2.5 disabled:cursor-default"
                  >
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                        current
                          ? "bg-blue-600 text-white ring-4 ring-blue-100"
                          : done
                            ? "bg-blue-600 text-white"
                            : "border-2 border-slate-300 bg-white text-slate-400"
                      }`}
                    >
                      {done ? <Check /> : n}
                    </span>
                    <span
                      className={`hidden text-xs font-semibold sm:block ${
                        current ? "text-blue-700" : done ? "text-slate-700" : "text-slate-400"
                      }`}
                    >
                      {tx(s.label)}
                    </span>
                  </button>
                  {i < STEPS.length - 1 && (
                    <span className={`mx-3 h-0.5 flex-1 rounded-full ${done ? "bg-blue-600" : "bg-slate-200"}`} aria-hidden="true" />
                  )}
                </li>
              );
            })}
          </ol>
          <p className="mt-3 text-sm text-slate-600">
            <span className="font-semibold text-slate-800">{tx("Step {0} of {1}", { 0: step, 1: LAST })}.</span>{" "}
            {tx(meta.help)}
          </p>
        </nav>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div ref={bodyRef} className="flex-1 space-y-5 overflow-y-auto bg-white px-6 py-5">
            {p.errorMsg && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm font-medium text-red-700">
                {p.errorMsg}
              </div>
            )}

            {/* The policy stays in view from step 2 on, so you never lose track of what the claim is against. */}
            {step > 1 && selectedPolicy && (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-blue-600">{tx("Claim against")}</p>
                  <p className="truncate text-sm font-bold text-slate-900">
                    {selectedPolicy.customer_name}{" "}
                    <span className="font-mono text-xs font-medium text-slate-500">
                      ({selectedPolicy.policy_number ?? selectedPolicy.id.slice(0, 8)})
                    </span>
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {selectedPolicy.product_name} · {titleCase(selectedPolicy.insurance_type || "Standard")} · {tx("Coverage limit")} {fmtPKR(limit)}
                  </p>
                </div>
                {step < LAST && (
                  <button type="button" onClick={() => goTo(1)} className="shrink-0 text-xs font-semibold text-blue-700 hover:underline">
                    {tx("Change")}
                  </button>
                )}
              </div>
            )}

            {/* Step 1 — policy */}
            {step === 1 && (
              <PolicyPicker policies={p.policies} filters={p.policyFilters} selectedId={form.policy_id} onSelect={p.onSelectPolicy} />
            )}

            {/* Step 2 — claim details */}
            {step === 2 && (
              <div className="space-y-5">
                <Field
                  label={tx("Claim type")}
                  hint={tx("Only the claim types this policy covers are listed.")}
                >
                  <select
                    autoFocus
                    className={inputClass}
                    value={form.claim_type}
                    onChange={(e) => onClaimTypeChange(e.target.value)}
                  >
                    {p.eligibleClaimTypes.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                </Field>

                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                  <Field
                    label={tx("Claim amount")}
                    error={amountError}
                    hint={
                      limit
                        ? amount > 0
                          ? tx("{0}% of the {1} coverage limit.", { 0: Math.round((amount / limit) * 100), 1: fmtPKR(limit) })
                          : tx("Up to {0}.", { 0: fmtPKR(limit) })
                        : undefined
                    }
                  >
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-400">PKR</span>
                      <input
                        type="number"
                        min={1}
                        max={limit || undefined}
                        inputMode="numeric"
                        value={form.submitted_amount || ""}
                        onChange={(e) => setForm({ ...form, submitted_amount: parseInt(e.target.value) || 0 })}
                        className={`${inputClass} pl-11 ${amountError ? "border-red-400 focus:border-red-500 focus:ring-red-500/20" : ""}`}
                      />
                    </div>
                    {limit > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {[25, 50, 100].map((pct) => (
                          <button
                            key={pct}
                            type="button"
                            onClick={() => setForm({ ...form, submitted_amount: Math.round((limit * pct) / 100) })}
                            className="rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-[11px] font-semibold text-slate-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
                          >
                            {pct === 100 ? tx("Full cover") : `${pct}%`}
                          </button>
                        ))}
                      </div>
                    )}
                  </Field>

                  <Field label={tx("Incident date")} hint={tx("The day the event happened.")}>
                    <input
                      type="date"
                      max={today}
                      value={form.incident_date ?? ""}
                      onChange={(e) => setForm({ ...form, incident_date: e.target.value })}
                      className={inputClass}
                    />
                  </Field>
                </div>

                <Field label={tx("Notes")} optional hint={tx("Anything the claims team should know about what happened.")}>
                  <textarea
                    rows={3}
                    value={form.notes ?? ""}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    placeholder={tx("Describe the event…")}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-hidden focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                  />
                </Field>
              </div>
            )}

            {/* Step 3 — claimant */}
            {step === 3 && (
              <div className="space-y-5">
                <div role="radiogroup" aria-label={tx("Claimant")} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {([
                    {
                      id: "SELF" as const,
                      title: "The policyholder",
                      desc: isDeath ? "A death claim can't be made by the insured person." : "The insured person is making this claim.",
                      disabled: isDeath,
                    },
                    {
                      id: "NOMINEE_BENEFICIARY" as const,
                      title: "Nominee, beneficiary or heir",
                      desc: isDeath ? "Someone claiming on the policyholder's behalf." : "Only available for death claims.",
                      disabled: !isDeath,
                    },
                  ]).map((o) => {
                    const checked = o.id === "SELF" ? claimantType === "SELF" : claimantType !== "SELF";
                    return (
                      <button
                        key={o.id}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        disabled={o.disabled}
                        onClick={() => {
                          p.setClaimantType(o.id);
                          if (o.id !== "SELF" && selectedPolicyDetail?.nominee_name && !claimantName) fillFromNominee();
                        }}
                        className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-colors ${
                          checked ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500" : "border-slate-200 bg-white hover:border-slate-300"
                        } ${o.disabled ? "cursor-not-allowed opacity-50" : ""}`}
                      >
                        <span
                          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                            checked ? "border-blue-600 bg-blue-600" : "border-slate-300 bg-white"
                          }`}
                        >
                          {checked && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                        </span>
                        <span>
                          <span className="block text-sm font-semibold text-slate-900">{tx(o.title)}</span>
                          <span className="mt-0.5 block text-xs text-slate-500">{tx(o.desc)}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                {claimantType === "SELF" ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5 text-sm text-slate-600">
                    {tx("The claim will be filed in the name of")}{" "}
                    <strong className="text-slate-900">{selectedPolicy?.customer_name}</strong>
                    {tx(". No further details are needed — continue to review.")}
                  </div>
                ) : (
                  <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
                    {selectedPolicyDetail?.nominee_name && (
                      <div className="flex items-center justify-between gap-3 rounded-lg bg-blue-50/70 px-3.5 py-2.5">
                        <div className="text-xs">
                          <span className="block text-[10px] font-bold uppercase tracking-wider text-blue-600">{tx("Nominee on the policy")}</span>
                          <span className="font-semibold text-slate-900">
                            {selectedPolicyDetail.nominee_name} ({selectedPolicyDetail.nominee_relationship || tx("Nominee")})
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={fillFromNominee}
                          className="shrink-0 rounded-lg border border-blue-200 bg-white px-3 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50"
                        >
                          {tx("Use these details")}
                        </button>
                      </div>
                    )}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <Field label={tx("Full name")}>
                        <input
                          autoFocus
                          type="text"
                          value={p.claimantName}
                          onChange={(e) => p.setClaimantName(e.target.value)}
                          placeholder={tx("e.g. Fatima Ahmed")}
                          className={inputClass}
                        />
                      </Field>
                      <Field label={tx("Relationship to the insured")}>
                        <select
                          value={claimantRelationship}
                          onChange={(e) => p.setClaimantRelationship(e.target.value)}
                          className={inputClass}
                        >
                          {RELATIONSHIPS.map((r) => (
                            <option key={r} value={r}>{r === "Executor" ? tx("Executor / Legal Representative") : tx(r)}</option>
                          ))}
                        </select>
                      </Field>
                      <Field
                        label={tx("CNIC / Government ID")}
                        optional
                        error={claimantCnic && claimantCnic.length < 15 ? tx("Enter all 13 digits.") : null}
                      >
                        <input
                          type="text"
                          inputMode="numeric"
                          maxLength={15}
                          value={claimantCnic}
                          onChange={(e) => p.setClaimantCnic(formatCnic(e.target.value))}
                          placeholder="42101-1234567-1"
                          className={`${inputClass} font-mono`}
                        />
                      </Field>
                      <Field label={tx("Phone number")} optional>
                        <input
                          type="tel"
                          value={claimantPhone}
                          onChange={(e) => p.setClaimantPhone(e.target.value)}
                          placeholder="+92 300 1234567"
                          className={inputClass}
                        />
                      </Field>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Step 4 — review */}
            {step === LAST && (
              <div className="space-y-4">
                <ReviewCard title={tx("Policy")} onEdit={() => goTo(1)}>
                  <Row label={tx("Policyholder")} value={selectedPolicy?.customer_name} />
                  <Row label={tx("Policy number")} value={selectedPolicy?.policy_number ?? selectedPolicy?.id.slice(0, 8)} />
                  <Row label={tx("Product")} value={selectedPolicy?.product_name} />
                  <Row label={tx("Coverage limit")} value={fmtPKR(limit)} />
                </ReviewCard>
                <ReviewCard title={tx("Claim")} onEdit={() => goTo(2)}>
                  <Row label={tx("Claim type")} value={form.claim_type} />
                  <Row
                    label={tx("Amount")}
                    value={
                      <>
                        {fmtPKR(amount)}
                        {limit > 0 && (
                          <span className="ml-1.5 text-xs font-medium text-slate-500">
                            ({Math.round((amount / limit) * 100)}% {tx("of cover")})
                          </span>
                        )}
                      </>
                    }
                  />
                  <Row label={tx("Incident date")} value={fmtDate(form.incident_date)} />
                  <Row label={tx("Notes")} value={form.notes?.trim() || tx("None")} wide />
                </ReviewCard>
                <ReviewCard title={tx("Claimant")} onEdit={() => goTo(3)}>
                  {claimantType === "SELF" ? (
                    <>
                      <Row label={tx("Name")} value={selectedPolicy?.customer_name} />
                      <Row label={tx("Relationship")} value={tx("Policyholder")} />
                    </>
                  ) : (
                    <>
                      <Row label={tx("Name")} value={claimantName.trim()} />
                      <Row label={tx("Relationship")} value={claimantRelationship} />
                      <Row label={tx("CNIC")} value={claimantCnic} />
                      <Row label={tx("Phone")} value={claimantPhone.trim()} />
                    </>
                  )}
                </ReviewCard>
              </div>
            )}
          </div>

          {/* Footer — always the same place: Back on the left, the one next action on the right */}
          <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-6 py-3.5">
            {step === 1 ? (
              <button
                type="button"
                onClick={p.onClose}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                {tx("Cancel")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => goTo(step - 1)}
                disabled={p.submitting}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                ← {tx("Back")}
              </button>
            )}

            <div className="flex min-w-0 items-center gap-3">
              {blocking && step < LAST && <p className="hidden truncate text-xs text-slate-500 sm:block">{blocking}</p>}
              {step < LAST ? (
                <button
                  type="submit"
                  disabled={!!blocking}
                  className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-2xs hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
                >
                  {tx("Continue")} →
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={p.submitting}
                  className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-2xs hover:bg-blue-700 disabled:opacity-60"
                >
                  {p.submitting ? tx("Submitting…") : tx("Submit claim")}
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
