"use client";

import { displayDate } from '../../lib/dateDisplay';
import { useState } from "react";
import { RuleVersionDetail } from "@/app/services/ruleEngine";
import { tx } from "@/lib/i18n/tx";

interface Props {
  versions: RuleVersionDetail[];
  selectedVersionId: string | null;
  onSelectVersion: (id: string) => void;
  onCreateVersion: () => void;
  onDeployVersion: (id: string) => void;
  isDeploying?: boolean;
  /** The app evaluates this rule set, so publishing changes live decisions. */
  inUse?: boolean;
}

const STATUS_LABEL: Record<string, string> = { ACTIVE: "Live", DRAFT: "Draft", ARCHIVED: "Previous" };

function when(iso?: string | null): string {
  return iso ? displayDate(iso, { month: "short", day: "numeric", year: "numeric" }) : "";
}

/** Which version is shown, what state it is in, and the one next step for it. */
export default function VersionBar({
  versions, selectedVersionId, onSelectVersion, onCreateVersion, onDeployVersion, isDeploying = false, inUse = false,
}: Props) {
  const [confirm, setConfirm] = useState(false);
  const current = versions.find((v) => v.id === selectedVersionId);
  const live = versions.find((v) => v.status === "ACTIVE");
  const draft = versions.find((v) => v.status === "DRAFT");

  if (versions.length === 0) {
    return (
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500">{tx("This rule set has no versions yet.")}</p>
        <button onClick={onCreateVersion} className="rounded-xl bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-700">
          {tx("Start a draft")}
        </button>
      </div>
    );
  }

  const tone =
    current?.status === "ACTIVE" ? "bg-emerald-50 text-emerald-700 ring-emerald-100"
    : current?.status === "DRAFT" ? "bg-blue-50 text-blue-700 ring-blue-100"
    : "bg-slate-100 text-slate-600 ring-slate-200";

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-slate-500">
          {tx("Version")}
          <select
            value={selectedVersionId ?? ""}
            onChange={(e) => onSelectVersion(e.target.value)}
            className="rounded-xl border border-slate-200 bg-white py-1.5 pl-3 pr-8 text-xs font-medium text-slate-800 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.version_number} · {tx(STATUS_LABEL[v.status] ?? v.status)}
              </option>
            ))}
          </select>
        </label>

        {current && (
          <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ring-1 ${tone}`}>
            {current.status === "ACTIVE" && tx("Live since {0}", { 0: when(current.effective_from) })}
            {current.status === "DRAFT" && tx("Draft — not live yet")}
            {current.status === "ARCHIVED" && tx("Previous version (read-only)")}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {current?.status === "DRAFT" ? (
            <button
              type="button"
              disabled={isDeploying}
              onClick={() => setConfirm(true)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
              {isDeploying ? tx("Publishing…") : tx("Publish changes")}
            </button>
          ) : draft ? (
            <button onClick={() => onSelectVersion(draft.id)} className="rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-100">
              {tx("Continue editing draft")}
            </button>
          ) : (
            <button
              onClick={onCreateVersion}
              title={tx("Copies the live rules into a draft you can edit safely")}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
              {tx("Edit rules")}
            </button>
          )}
        </div>
      </div>
      {current?.status === "ACTIVE" && !draft && (
        <p className="mt-2 text-[11px] text-slate-400">{tx("Live rules are locked. “Edit rules” makes a draft copy; nothing changes until you publish it.")}</p>
      )}

      {confirm && current && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
          onClick={() => setConfirm(false)}
          role="dialog"
          aria-modal="true"
        >
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="px-6 pb-2 pt-6">
              <h3 className="text-base font-semibold text-slate-900">{tx("Publish version {0}?", { 0: current.version_number })}</h3>
              <p className="mt-2 text-sm text-slate-600">
                {tx("Its {0} rules become the live rules", { 0: current.rules?.length || 0 })}
                {live ? tx(", replacing version {0}.", { 0: live.version_number }) : "."}
              </p>
              {inUse ? (
                <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">{tx("This rule set is in use — new decisions follow these rules immediately.")}</p>
              ) : (
                <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">{tx("This rule set is reference only, so no live decision changes.")}</p>
              )}
            </div>
            <div className="flex justify-end gap-2 px-6 pb-6 pt-4">
              <button onClick={() => setConfirm(false)} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                {tx("Cancel")}
              </button>
              <button
                disabled={isDeploying}
                onClick={() => { onDeployVersion(current.id); setConfirm(false); }}
                className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
              >
                {tx("Publish")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
