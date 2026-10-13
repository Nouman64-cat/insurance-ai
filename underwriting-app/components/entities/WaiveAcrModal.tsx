"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import ModalPortal from "@/components/ModalPortal";
import { tx } from "@/lib/i18n/tx";

const MIN_REASON = 5;

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="bg-blue-600 px-5 py-3">
            <p className="text-white/80 text-[11px] font-semibold uppercase tracking-wider">{tx("Pre-Underwriting")}</p>
            <h2 className="text-white text-lg font-bold">{title}</h2>
          </div>
          {children}
        </div>
      </div>
    </ModalPortal>
  );
}

/** Asks for the reason before an underwriter bypasses Gate 2 (the agent's report). */
export function WaiveAcrModal({
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

  const trimmed = reason.trim();
  const valid = trimmed.length >= MIN_REASON;

  return (
    <Shell title={tx("Waive Agent's Confidential Report")} onClose={busy ? () => {} : onCancel}>
      <div className="p-5 space-y-3">
        <p className="text-sm text-slate-600 leading-relaxed">
          {applicantName
            ? tx("Gate 2 will be marked cleared for {0} without the agent's report.", { 0: applicantName })
            : tx("Gate 2 will be marked cleared without the agent's report.")}{" "}
          {tx("Your name, the time and the reason below are kept on record. The agent can still file the report later.")}
        </p>
        <div>
          <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
            {tx("Reason for waiving")}
          </label>
          <textarea
            ref={ref}
            rows={3}
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && valid && !busy) onConfirm(trimmed);
            }}
            placeholder={tx("e.g. Agent unreachable; income verified through salary slips")}
            className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 disabled:opacity-60"
          />
          <p className="text-[11px] text-slate-400 mt-1">
            {valid ? "" : tx("At least {0} characters.", { 0: MIN_REASON })}
          </p>
        </div>
        {error && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
        )}
      </div>
      <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100">
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-3 py-1.5 text-sm font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-50"
        >
          {tx("Cancel")}
        </button>
        <button
          onClick={() => onConfirm(trimmed)}
          disabled={!valid || busy}
          className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40"
        >
          {busy ? tx("Saving…") : tx("Waive ACR")}
        </button>
      </div>
    </Shell>
  );
}

/** Confirms undoing a waiver, so Gate 2 needs the agent's submitted report again. */
export function UndoWaiverModal({
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Shell title={tx("Undo ACR waiver")} onClose={busy ? () => {} : onCancel}>
      <div className="p-5 space-y-3">
        <p className="text-sm text-slate-600 leading-relaxed">
          {tx("Gate 2 will need the agent's submitted report again, and the case will wait for it.")}
        </p>
        {error && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
        )}
      </div>
      <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100">
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-3 py-1.5 text-sm font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-50"
        >
          {tx("Cancel")}
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40"
        >
          {busy ? tx("Saving…") : tx("Undo waiver")}
        </button>
      </div>
    </Shell>
  );
}
