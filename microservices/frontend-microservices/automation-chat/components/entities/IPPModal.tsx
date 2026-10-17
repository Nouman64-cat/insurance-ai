"use client";

import { useEffect, useState } from "react";
import { initiateIPP, confirmIPP, type PaymentMethod } from "@/app/services/initialPremiumPayment";

const fmtPKR = (n: number | null | undefined) =>
  n == null ? "—" : `PKR ${Math.round(n).toLocaleString()}`;

// Initial Premium Payment modal — collected at proposal submission, before
// underwriting risk assessment begins (Section 30, "no premium, no risk").
// Styled to match policy-issuance/page.tsx's PaymentModal (the *other*
// premium-collection UI, which runs post-underwriting-decision, pre-bind).
export function IPPModal({ caseId, customerName, onClose, onConfirmed }: {
  caseId: string; customerName?: string; onClose: () => void; onConfirmed: () => void;
}) {
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [amount, setAmount] = useState<number | null>(null);
  const [reference, setReference] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await initiateIPP(caseId);
        if (!alive) return;
        setMethods(res.available_payment_methods);
        setSelected(res.payment.method);
        setAmount(res.amount);
        setReference(res.payment.reference);
      } catch (e: any) {
        if (alive) setError(e?.response?.data?.detail ?? e?.message ?? "Failed to load payment details.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [caseId]);

  const handleConfirm = async () => {
    setConfirming(true); setError(null);
    try {
      await confirmIPP(caseId, { method: selected, reference });
      onConfirmed();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? e?.message ?? "Payment confirmation failed.");
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-slate-200 overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="bg-gradient-to-r from-blue-600 to-blue-700 px-6 py-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-blue-100 text-xs font-medium uppercase tracking-widest">Pre-Underwriting</p>
              <h2 className="text-white text-lg font-bold mt-0.5">Initial Premium Payment</h2>
            </div>
            <button onClick={onClose} className="text-white/60 hover:text-white transition-colors">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div className="px-6 py-5 space-y-5">
          <p className="text-xs text-slate-500">
            Per Section 30 of the Insurance Ordinance 2000 ("no premium, no risk"), the initial
            premium must clear before this case proceeds to underwriting risk assessment.
          </p>

          {customerName && (
            <div className="bg-slate-50 rounded-xl p-4 space-y-1">
              <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider">Applicant</p>
              <p className="text-sm font-bold text-slate-900">{customerName}</p>
            </div>
          )}

          <div className="flex items-center justify-between border-y border-slate-100 py-3">
            <p className="text-sm font-semibold text-slate-700">Amount Due</p>
            <p className="text-lg font-bold text-blue-700">{loading ? "…" : fmtPKR(amount)}</p>
          </div>

          <div>
            <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-2">Payment Channel</p>
            <div className="grid grid-cols-2 gap-2">
              {methods.map((m) => (
                <button
                  key={m.code}
                  onClick={() => setSelected(m.code)}
                  className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-all ${selected === m.code ? "bg-blue-50 border-blue-300 text-blue-800" : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {reference && (
            <p className="text-[11px] text-slate-400 font-mono">Reference: {reference}</p>
          )}

          {error && <p className="text-xs text-red-600">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="px-3 py-1.5 text-sm font-semibold text-slate-500 hover:text-slate-700">Cancel</button>
            <button onClick={handleConfirm} disabled={loading || confirming}
              className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40">
              {confirming ? "Confirming…" : "Confirm Payment"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
