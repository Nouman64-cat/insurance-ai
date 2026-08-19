"use client";

import { useState } from "react";
import { RuleVersionDetail } from "@/app/services/ruleEngine";

interface Props {
  versions: RuleVersionDetail[];
  selectedVersionId: string | null;
  onSelectVersion: (id: string) => void;
  onCreateVersion: () => void;
  onDeployVersion: (id: string) => void;
  isDeploying?: boolean;
}

function formatEffectiveDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function statusClasses(status: string): string {
  switch (status) {
    case "ACTIVE":   return "bg-emerald-50 text-emerald-800 border-emerald-300 ring-emerald-300 font-bold";
    case "DRAFT":    return "bg-blue-50 text-blue-800 border-blue-300 ring-blue-300 font-bold";
    case "ARCHIVED": return "bg-slate-100 text-slate-600 border-slate-300 ring-slate-300 font-medium";
    default:         return "bg-slate-100 text-slate-700 border-slate-300";
  }
}

function statusDot(status: string): string {
  switch (status) {
    case "ACTIVE":   return "bg-emerald-500";
    case "DRAFT":    return "bg-blue-500"; // Solid dot, no constant pulse field
    case "ARCHIVED": return "bg-slate-400";
    default:         return "bg-slate-400";
  }
}

export default function VersionBar({
  versions, selectedVersionId, onSelectVersion, onCreateVersion, onDeployVersion, isDeploying = false,
}: Props) {
  const [showConfirmDeploy, setShowConfirmDeploy] = useState(false);
  const current = versions.find((v) => v.id === selectedVersionId);
  const activeVersion = versions.find((v) => v.status === "ACTIVE");

  const handleConfirmDeploy = () => {
    if (current) {
      onDeployVersion(current.id);
      setShowConfirmDeploy(false);
    }
  };

  if (versions.length === 0) {
    return (
      <div className="flex items-center justify-between px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl">
        <span className="text-xs text-slate-500 italic">No versions yet.</span>
        <button
          onClick={onCreateVersion}
          className="flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Create First Version
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="border border-slate-200 rounded-xl overflow-hidden bg-white shadow-sm">
        {/* Version pills row */}
        <div className="flex items-center gap-2 px-4 py-2.5 overflow-x-auto border-b border-slate-100 bg-slate-50/70">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500 shrink-0 mr-1">
            Versions
          </span>
          {versions.map((v) => (
            <button
              key={v.id}
              onClick={() => onSelectVersion(v.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition shrink-0 ${
                selectedVersionId === v.id
                  ? "ring-1 " + statusClasses(v.status)
                  : "bg-white border-slate-200 text-slate-700 hover:border-slate-300 hover:bg-slate-50 font-medium"
              }`}
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot(v.status)}`} />
              v{v.version_number}
              <span className="font-normal text-slate-500">· {v.status}</span>
            </button>
          ))}
          <button
            onClick={onCreateVersion}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 border border-dashed border-slate-300 hover:border-blue-500 hover:text-blue-600 hover:bg-blue-50/50 transition shrink-0"
            title="Create new draft version"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Draft
          </button>
        </div>

        {/* Selected version metadata */}
        {current && (
          <div className="flex items-center justify-between px-4 py-2.5 gap-4 bg-white">
            <div className="flex items-center gap-2 text-xs text-slate-600 flex-wrap font-medium">
              {current.effective_from && (
                <span>
                  Effective: <span className="font-mono text-slate-800">{formatEffectiveDate(current.effective_from)}</span>
                  {current.effective_to && <span> – <span className="font-mono text-slate-800">{formatEffectiveDate(current.effective_to)}</span></span>}
                </span>
              )}
              {current.authored_by && (
                <span>Authored by: <span className="font-semibold text-slate-800">{current.authored_by}</span></span>
              )}
              {current.approved_by && (
                <span className="text-emerald-700">· Approved by: <span className="font-semibold">{current.approved_by}</span></span>
              )}
              <span className="text-slate-400">·</span>
              <span className="text-slate-500">{current.rules?.length || 0} rules</span>
            </div>

            {current.status === "DRAFT" && (
              <button
                type="button"
                disabled={isDeploying}
                onClick={() => setShowConfirmDeploy(true)}
                className="flex items-center gap-1.5 px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-semibold rounded-lg shadow-sm transition shrink-0 cursor-pointer"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                {isDeploying ? "Deploying..." : "Deploy to Active"}
              </button>
            )}

            {current.status === "ACTIVE" && (
              <span className="flex items-center gap-1.5 px-3 py-1 bg-emerald-50 text-emerald-800 text-xs font-bold rounded-lg border border-emerald-200 shrink-0">
                <svg className="w-4 h-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Active Production Version
              </span>
            )}
          </div>
        )}
      </div>

      {/* Confirmation Modal before Deployment */}
      {showConfirmDeploy && current && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm"
          onClick={() => setShowConfirmDeploy(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white w-full max-w-md rounded-2xl shadow-2xl border border-slate-200 overflow-hidden"
          >
            <div className="px-6 py-5 border-b border-slate-100 flex items-center gap-3 bg-amber-50/50">
              <div className="p-2 bg-amber-100 text-amber-700 rounded-xl">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">Deploy Version v{current.version_number}</h3>
                <p className="text-xs text-amber-800 font-medium">Production Release Confirmation</p>
              </div>
            </div>

            <div className="px-6 py-5 space-y-3 text-xs text-slate-700">
              <p>
                You are about to activate <span className="font-bold text-slate-900">Draft v{current.version_number}</span> ({current.rules?.length || 0} rules).
              </p>
              {activeVersion && (
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <p className="text-slate-500 text-[11px]">Current Active Version:</p>
                  <p className="font-semibold text-slate-800">
                    v{activeVersion.version_number} (Live since {activeVersion.effective_from ? formatEffectiveDate(activeVersion.effective_from) : "creation"})
                  </p>
                  <p className="text-slate-500 text-[11px] mt-1">
                    Deploying will archive v{activeVersion.version_number} and immediately enforce v{current.version_number} in live underwriting evaluations.
                  </p>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2 bg-slate-50/60">
              <button
                type="button"
                onClick={() => setShowConfirmDeploy(false)}
                className="px-4 py-2 text-xs font-semibold text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isDeploying}
                onClick={handleConfirmDeploy}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
              >
                {isDeploying ? "Deploying..." : "Confirm & Deploy to Production"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
