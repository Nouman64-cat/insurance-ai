"use client";

import { useEffect, useRef, useState } from "react";
import ModalPortal from "@/components/ModalPortal";
import { tx } from "@/lib/i18n/tx";

const MIN_REASON = 5;

/** Asks why the case is being put on hold. The reason is kept on the case and shown on the Leads page. */
export function HoldCaseModal({
  applicantName,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  applicantName?: string | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  const trimmed = reason.trim();
  const valid = trimmed.length >= MIN_REASON;

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4" onClick={busy ? undefined : onCancel}>
        <div role="dialog" aria-modal="true" className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
          <div className="bg-blue-600 px-5 py-3">
            <p className="text-white/80 text-[11px] font-semibold uppercase tracking-wider">{tx("Underwriting")}</p>
            <h2 className="text-white text-lg font-bold">{tx("Put the case on hold")}</h2>
          </div>
          <div className="p-5 space-y-3">
            <p className="text-sm text-slate-600 leading-relaxed">
              {applicantName
                ? tx("The whole underwriting process for {0} will pause exactly where it is.", { 0: applicantName })
                : tx("The whole underwriting process will pause exactly where it is.")}{" "}
              {tx("Nothing is lost: when you remove the hold it carries on from the same step. The lead will show as On hold.")}
            </p>
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{tx("Reason for the hold")}</label>
              <textarea
                ref={ref}
                rows={3}
                value={reason}
                disabled={busy}
                maxLength={1000}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && valid && !busy) onConfirm(trimmed); }}
                placeholder={tx("e.g. CNIC photo does not match the details entered")}
                className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 disabled:opacity-60"
              />
              <p className="text-[11px] text-slate-400 mt-1">{valid ? "" : tx("At least {0} characters.", { 0: MIN_REASON })}</p>
            </div>
            {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
          </div>
          <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100">
            <button onClick={onCancel} disabled={busy} className="px-3 py-1.5 text-sm font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-50">{tx("Cancel")}</button>
            <button onClick={() => onConfirm(trimmed)} disabled={!valid || busy} className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40">
              {busy ? tx("Saving…") : tx("Put on hold")}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
