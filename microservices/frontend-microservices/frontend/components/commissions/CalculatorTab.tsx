"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  CHANNEL_LABELS,
  COMMISSION_RATE_CARD,
  CommissionPayee,
  DistributionChannel,
  PolicySegment,
  PremiumType,
  ProducerSplit,
  WaterfallResult,
  accrueCommissionForPolicy,
  previewCommissionWaterfall,
} from "../../app/services/commissions";
import {
  BasisLabel,
  Card,
  EntryKindBadge,
  Field,
  PayeeTypeBadge,
  StageTimeline,
  fmtPKR,
  fmtPct,
  inputClass,
  selectClass,
} from "./shared";
import { tx } from "@/lib/i18n/tx";

const PARTNER_TYPES = ["BANK_PARTNER", "BROKER", "AGENCY", "HOUSE"];

/**
 * Modernized Rate & Commission Waterfall Calculator.
 * Models premium events end-to-end with real-time producer splits, rate-card previews,
 * tax deductions, and milestone tranche release schedules.
 */
export default function CalculatorTab({
  payees,
  onAccrued,
  notify,
}: {
  payees: CommissionPayee[];
  onAccrued: () => void;
  notify: (msg: string, ok?: boolean) => void;
}) {
  const [customer, setCustomer] = useState("Muhammad Usman");
  const [premium, setPremium] = useState(300_000);
  const [segment, setSegment] = useState<PolicySegment>("individual");
  const [premiumType, setPremiumType] = useState<PremiumType>("FIRST_YEAR");
  const [policyYear, setPolicyYear] = useState(1);
  const [channel, setChannel] = useState<DistributionChannel>("DIRECT_AGENCY");
  const [isIssued, setIsIssued] = useState(true);
  const [isCollected, setIsCollected] = useState(true);
  const [includeReferral, setIncludeReferral] = useState(false);

  const producerChannel: DistributionChannel = channel === "REFERRAL" ? "DIRECT_AGENCY" : channel;

  const producerCandidates = useMemo(
    () =>
      payees.filter(
        (p) =>
          !PARTNER_TYPES.includes(p.type) &&
          COMMISSION_RATE_CARD.some(
            (r) => r.active && r.channel === producerChannel && r.payeeType === p.type && r.basis === "PREMIUM",
          ),
      ),
    [payees, producerChannel],
  );

  const partnerCandidates = useMemo(
    () =>
      payees.filter(
        (p) =>
          PARTNER_TYPES.includes(p.type) &&
          COMMISSION_RATE_CARD.some(
            (r) => r.active && r.channel === channel && r.payeeType === p.type && r.basis === "PREMIUM",
          ),
      ),
    [payees, channel],
  );

  const staffCandidates = useMemo(
    () =>
      payees.filter((p) =>
        COMMISSION_RATE_CARD.some(
          (r) => r.active && r.channel === channel && r.payeeType === p.type && r.basis === "PARTNER_COMMISSION",
        ),
      ),
    [payees, channel],
  );

  const referralCandidates = useMemo(() => payees.filter((p) => p.type === "REFERRAL_PARTNER"), [payees]);

  const [producers, setProducers] = useState<ProducerSplit[]>([]);
  const [partnerId, setPartnerId] = useState("");
  const [staffId, setStaffId] = useState("");
  const [referralId, setReferralId] = useState("");
  const [result, setResult] = useState<WaterfallResult | null>(null);

  useEffect(() => {
    setProducers(producerCandidates.length > 0 ? [{ payeeId: producerCandidates[0].id, splitPct: 100 }] : []);
    setPartnerId(partnerCandidates[0]?.id ?? "");
    setStaffId(staffCandidates[0]?.id ?? "");
    setReferralId(referralCandidates[0]?.id ?? "");
    setIncludeReferral(channel === "REFERRAL");
  }, [channel, producerCandidates, partnerCandidates, staffCandidates, referralCandidates]);

  const buildInput = () => ({
    customerName: customer,
    segment,
    premiumType,
    policyYear,
    collectedPremium: premium,
    channel: producerChannel,
    producers,
    partnerPayeeId: partnerId || null,
    partnerStaffPayeeId: staffId || null,
    referralPayeeId: includeReferral ? referralId || null : null,
    isIssued,
    isPremiumCollected: isCollected,
  });

  useEffect(() => {
    let cancelled = false;
    previewCommissionWaterfall(buildInput())
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch(() => {
        if (!cancelled) setResult(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer, premium, segment, premiumType, policyYear, producerChannel, producers, partnerId, staffId, referralId, includeReferral, isIssued, isCollected]);

  const accrue = async () => {
    try {
      const posted = await accrueCommissionForPolicy(buildInput());
      if (posted.entries.length === 0) {
        notify(tx("Nothing to accrue — no rate-card row matched the selected parties."), false);
        return;
      }
      notify(tx("{0} commission entries accrued for {1} payees.", { 0: posted.entries.length, 1: posted.entries.length }));
      onAccrued();
    } catch (err) {
      notify(err instanceof Error ? err.message : tx("Could not accrue the commission"), false);
    }
  };

  const splitTotal = producers.reduce((s, p) => s + p.splitPct, 0);
  const taxDeductions = (result?.totalGross ?? 0) - (result?.totalNet ?? 0);

  return (
    <div className="space-y-5">
      {/* Main Grid: Parameters Left, Real-time Summary Right */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Left Column: Form Controls & Sales Parties */}
        <div className="xl:col-span-2 space-y-4">
          <Card title={tx("Policy & Premium Parameters")} >
            <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label={tx("Customer / Proposer Name")}>
                <input value={customer} onChange={(e) => setCustomer(e.target.value)} className={inputClass} />
              </Field>
              <Field label={tx("Recognized Premium (PKR)")}>
                <input
                  type="number"
                  value={premium}
                  onChange={(e) => setPremium(Number(e.target.value))}
                  className={`${inputClass} font-mono font-bold text-slate-900`}
                />
              </Field>
              <Field label={tx("Distribution Channel")}>
                <select
                  value={channel}
                  onChange={(e) => setChannel(e.target.value as DistributionChannel)}
                  className={selectClass}
                >
                  {(Object.keys(CHANNEL_LABELS) as DistributionChannel[]).map((c) => (
                    <option key={c} value={c}>
                      {tx(CHANNEL_LABELS[c])}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={tx("Policy Segment")}>
                <select value={segment} onChange={(e) => setSegment(e.target.value as PolicySegment)} className={selectClass}>
                  <option value="individual">{tx("Individual Life Insurance")}</option>
                  <option value="group">{tx("Group Corporate Policy")}</option>
                  <option value="family">{tx("Family Takaful")}</option>
                </select>
              </Field>
              <Field label={tx("Premium Type")}>
                <select
                  value={premiumType}
                  onChange={(e) => setPremiumType(e.target.value as PremiumType)}
                  className={selectClass}
                >
                  <option value="FIRST_YEAR">{tx("First-Year Premium (FYP)")}</option>
                  <option value="RENEWAL">{tx("Renewal Premium (RYP)")}</option>
                  <option value="SINGLE_PREMIUM">{tx("Single Premium (SP)")}</option>
                </select>
              </Field>
              <Field label={tx("Policy Year")}>
                <select value={policyYear} onChange={(e) => setPolicyYear(Number(e.target.value))} className={selectClass}>
                  <option value={1}>{tx("Year 1 (Acquisition)")}</option>
                  <option value={2}>{tx("Year 2 (Persistency)")}</option>
                  <option value={3}>{tx("Year 3+ (Renewal Trail)")}</option>
                  <option value={5}>{tx("Year 5 (Trail band)")}</option>
                </select>
              </Field>

              {/* Status Checklist Toggles */}
              <div className="md:col-span-2 flex flex-wrap items-center gap-6 pt-3 border-t border-slate-100">
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={isIssued}
                    onChange={(e) => setIsIssued(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  {tx("Policy Issued")}
                </label>
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={isCollected}
                    onChange={(e) => setIsCollected(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  {tx("Premium Realised & Collected")}
                </label>
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={includeReferral}
                    onChange={(e) => setIncludeReferral(e.target.checked)}
                    disabled={referralCandidates.length === 0}
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  {tx("Pay Referral Fee")}
                </label>
              </div>
            </div>
          </Card>

          <Card title={tx("Parties to the Sale & Splits")}>
            <div className="p-5 space-y-4">
              {producerCandidates.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-slate-800 uppercase tracking-wider text-[11px]">{tx("Writing Producers")}</p>
                    <span
                      className={`text-xs font-extrabold px-2.5 py-0.5 rounded-full border ${Math.abs(splitTotal - 100) < 0.01
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-rose-50 text-rose-700 border-rose-200"
                        }`}
                    >
                      {Math.abs(splitTotal - 100) < 0.01 ? tx("✓ 100% Split Allocated") : tx("Split Total {0} (Must equal 100%)", { 0: fmtPct(splitTotal) })}
                    </span>
                  </div>

                  {producers.map((split, idx) => (
                    <div key={`${split.payeeId}-${idx}`} className="flex items-center gap-2">
                      <div className="flex-1">
                        <select
                          value={split.payeeId}
                          onChange={(e) => {
                            const next = [...producers];
                            next[idx] = { ...next[idx], payeeId: e.target.value };
                            setProducers(next);
                          }}
                          className={selectClass}
                        >
                          {producerCandidates.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} — ({p.code})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="w-32 flex items-center gap-1">
                        <input
                          type="number"
                          value={split.splitPct}
                          onChange={(e) => {
                            const next = [...producers];
                            next[idx] = { ...next[idx], splitPct: Number(e.target.value) };
                            setProducers(next);
                          }}
                          className={`${inputClass} font-mono font-bold text-slate-900 text-center`}
                        />
                        <span className="text-xs font-bold text-slate-500">%</span>
                      </div>
                      {producers.length > 1 && (
                        <button
                          onClick={() => setProducers(producers.filter((_, i) => i !== idx))}
                          className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg border border-slate-200 transition-colors"
                          title={tx("Remove co-producer")}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}

                  <button
                    onClick={() => {
                      const used = new Set(producers.map((p) => p.payeeId));
                      const next = producerCandidates.find((p) => !used.has(p.id));
                      if (!next) return;
                      const share = Math.round(100 / (producers.length + 1));
                      setProducers([
                        ...producers.map((p) => ({ ...p, splitPct: share })),
                        { payeeId: next.id, splitPct: 100 - share * producers.length },
                      ]);
                    }}
                    className="px-3.5 py-1.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-700 rounded-lg text-xs font-bold transition-all"
                  >
                    {tx("+ Add Co-Producer (Split Case)")}
                  </button>
                </div>
              )}

              {partnerCandidates.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t border-slate-100">
                  <Field label={tx("Channel Partner")}>
                    <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)} className={selectClass}>
                      <option value="">{tx("— None —")}</option>
                      {partnerCandidates.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} — {p.code}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {staffCandidates.length > 0 && (
                    <Field label={tx("Partner's Front-Line Staff")}>
                      <select value={staffId} onChange={(e) => setStaffId(e.target.value)} className={selectClass}>
                        <option value="">{tx("— None —")}</option>
                        {staffCandidates.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} — {p.code}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                </div>
              )}

              {includeReferral && referralCandidates.length > 0 && (
                <div className="pt-3 border-t border-slate-100">
                  <Field label={tx("Referral Partner")}>
                    <select value={referralId} onChange={(e) => setReferralId(e.target.value)} className={selectClass}>
                      {referralCandidates.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} — {p.code}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Right Sidebar: Real-Time Calculation & Payout Action */}
        <div className="space-y-4">
          <div className="bg-white p-5 rounded-2xl shadow-2xs border border-slate-200 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="font-extrabold text-xs text-slate-900 uppercase tracking-wider">{tx("Calculation Summary")}</h3>
              <span className="px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 font-mono text-[11px] font-bold border border-blue-200">
                {result?.entries.length ?? 0}{" "}{tx("Waterfall Rows")}
              </span>
            </div>

            <div className="space-y-2.5 text-xs">
              <Row label={tx("Recognized Premium")} value={fmtPKR(premium)} />
              <Row label={tx("Total Gross Commission")} value={fmtPKR(result?.totalGross ?? 0)} strong />
              <Row label={tx("Statutory Deductions")} value={`- ${fmtPKR(taxDeductions)}`} />
              <div className="pt-3 border-t border-slate-100 flex justify-between items-center">
                <span className="font-extrabold text-slate-900 text-sm">{tx("Total Net Payable")}</span>
                <span className="font-extrabold tabular-nums text-blue-700 text-xl">{fmtPKR(result?.totalNet ?? 0)}</span>
              </div>
            </div>

            {result && (
              <div className="space-y-2 bg-slate-50/70 p-3.5 rounded-xl border border-slate-200/80">
                <div className="flex justify-between text-xs font-semibold">
                  <span className="text-slate-600">{tx("Commission vs Ceiling Cap")}</span>
                  <span className={`font-mono font-extrabold ${result.ceilingBreached ? "text-rose-600" : "text-emerald-700"}`}>
                    {fmtPct(result.effectiveRatePct)} / {fmtPct(result.ceilingPct)}{" "}{tx("Cap")}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${result.ceilingBreached ? "bg-rose-500" : "bg-emerald-500"}`}
                    style={{ width: `${Math.min(100, (result.effectiveRatePct / Math.max(result.ceilingPct, 1)) * 100)}%` }}
                  />
                </div>
                <p className="text-[10px] text-slate-500">{tx("Maximum allowed payout cap across all payees on this policy")}</p>
              </div>
            )}

            {result && result.warnings.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-1">
                <p className="text-[10px] font-bold text-amber-800 uppercase tracking-wider">{tx("Engine Warnings")}</p>
                {result.warnings.map((w) => (
                  <p key={w} className="text-[11px] text-amber-900">
                    • {w}
                  </p>
                ))}
              </div>
            )}

            <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 text-[11px] text-slate-600 space-y-1">
              <p className="font-bold text-slate-800">{tx("Release Conditions")}</p>
              <p className="leading-relaxed">
                {tx("Commissions are held in pending status until the policy is issued, premium is realised, and free-look period closes.")}
              </p>
            </div>

            <button
              onClick={accrue}
              disabled={!result || result.entries.length === 0}
              className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-200 disabled:text-slate-400 text-white font-extrabold text-xs rounded-xl shadow-xs transition-all flex items-center justify-center gap-2"
            >
              <span>{tx("Accrue Full Stack to Ledger")}</span>
              <span>→</span>
            </button>
          </div>
        </div>
      </div>

      {/* Computed Payout Stack Table */}
      <Card title={tx("Computed Waterfall Ledger Entries")}>
        {!result || result.entries.length === 0 ? (
          <div className="px-5 py-8 text-center text-xs text-slate-400">
            {tx("No rate-card row matches the selected channel and parties.")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50/80 text-slate-500 font-medium uppercase tracking-wider text-[10px] border-b border-slate-200">
                <tr>
                  <th className="p-3">{tx("Payee")}</th>
                  <th className="p-3">{tx("Kind")}</th>
                  <th className="p-3">{tx("Applied To")}</th>
                  <th className="p-3 text-right">{tx("Rate")}</th>
                  <th className="p-3 text-right">{tx("Gross")}</th>
                  <th className="p-3 text-right">{tx("Tax / Deductions")}</th>
                  <th className="p-3 text-right">{tx("Net")}</th>
                  <th className="p-3">{tx("Release Schedule")}</th>
                  <th className="p-3 text-right">{tx("Due At Once")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.entries.map((e) => (
                  <tr key={e.id} className={e.parentEntryId ? "bg-slate-50/40" : "hover:bg-slate-50/60"}>
                    <td className="p-3">
                      <div className="flex items-start gap-2">
                        {e.parentEntryId && <span className="text-slate-300 font-mono mt-0.5">└</span>}
                        <div>
                          <p className="font-bold text-slate-900">{e.payeeName}</p>
                          <PayeeTypeBadge type={e.payeeType} />
                        </div>
                      </div>
                    </td>
                    <td className="p-3">
                      <EntryKindBadge kind={e.entryKind} />
                      <p className="text-[10px] font-mono text-slate-400 mt-1">{e.ruleId}</p>
                    </td>
                    <td className="p-3">
                      <BasisLabel basis={e.basis} amount={e.basisAmount} />
                    </td>
                    <td className="p-3 text-right font-mono font-bold">{fmtPct(e.ratePct)}</td>
                    <td className="p-3 text-right font-semibold tabular-nums text-slate-900">{fmtPKR(e.grossCommission)}</td>
                    <td className="p-3 text-right font-mono text-slate-500">
                      <span title={e.deductions.map((d) => `${d.label} @ ${d.pct}%`).join("\n")} className="cursor-help">
                        - {fmtPKR(e.deductions.reduce((s, d) => s + d.amount, 0))}
                      </span>
                    </td>
                    <td className="p-3 text-right font-semibold tabular-nums text-blue-700">{fmtPKR(e.netCommission)}</td>
                    <td className="p-3">
                      <StageTimeline stages={e.stages} compact />
                    </td>
                    <td className="p-3 text-right font-mono font-bold text-blue-700">
                      {fmtPKR(e.dueNet)}
                      {e.pendingNet > 0 && (
                        <p className="text-[10px] font-normal text-slate-400">{fmtPKR(e.pendingNet)}{" "}{tx("later")}</p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-50 border-t border-slate-200 font-bold">
                <tr>
                  <td className="p-3" colSpan={4}>
                    {tx("Total across")}{" "}{result.entries.length}{" "}{tx("payees")}
                  </td>
                  <td className="p-3 text-right font-mono text-slate-900">{fmtPKR(result.totalGross)}</td>
                  <td className="p-3 text-right font-mono text-slate-500">- {fmtPKR(taxDeductions)}</td>
                  <td className="p-3 text-right font-mono text-blue-700">{fmtPKR(result.totalNet)}</td>
                  <td className="p-3" />
                  <td className="p-3 text-right font-mono text-blue-700">
                    {fmtPKR(result.entries.reduce((s, e) => s + e.dueNet, 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-slate-600">{label}</span>
      <span className={`font-mono ${strong ? "font-bold text-slate-900" : "text-slate-700"}`}>{value}</span>
    </div>
  );
}
