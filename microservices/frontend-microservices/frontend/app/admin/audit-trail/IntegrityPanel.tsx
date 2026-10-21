"use client";

import { useState } from "react";
import { tx } from "@/lib/i18n/tx";
import {
  ChainSummary, INTEGRITY_LABEL, IntegrityState, OpsStatus, VerificationResult, VerificationRun,
  describeReason, formatTime, integrityState, relativeTime, shortHash,
} from "@/lib/audit";

const TONE: Record<IntegrityState, { dot: string; text: string; ring: string }> = {
  valid: { dot: "bg-emerald-500", text: "text-emerald-700", ring: "border-emerald-200 bg-emerald-50/50" },
  invalid: { dot: "bg-rose-500", text: "text-rose-700", ring: "border-rose-200 bg-rose-50/60" },
  pending: { dot: "bg-amber-500", text: "text-amber-700", ring: "border-amber-200 bg-amber-50/50" },
};

interface Props {
  chains: ChainSummary[];
  chain: ChainSummary | null;
  onSelectChain: (chainId: string) => void;
  tenantLabel: (tenantId: string | null) => string;
  isSuperAdmin: boolean;
  latest: VerificationResult | VerificationRun | null;
  verifying: boolean;
  verifyError: string;
  onVerify: () => void;
  onShowEvent: (chainId: string, sequence: number) => void;
  ops: OpsStatus | null;
}

export default function IntegrityPanel({
  chains, chain, onSelectChain, tenantLabel, isSuperAdmin, latest, verifying, verifyError, onVerify, onShowEvent, ops,
}: Props) {
  const [showDetails, setShowDetails] = useState(false);
  const state = integrityState(latest);
  const tone = TONE[state];
  const verifiedAt = latest ? ("verified_at" in latest ? latest.verified_at : latest.finished_at) : null;
  const checkedAll = latest ? ("head_checked" in latest ? latest.head_checked : true) : false;

  return (
    <section aria-label={tx("Chain integrity")} className={`rounded-xl border shadow-sm ${tone.ring}`}>
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${tone.dot}`} aria-hidden="true" />
            <h2 className={`text-sm font-semibold ${tone.text}`} role="status">{tx(INTEGRITY_LABEL[state])}</h2>
            {isSuperAdmin && chains.length > 1 && (
              <select
                aria-label={tx("Chain")}
                value={chain?.chain_id ?? ""}
                onChange={(e) => onSelectChain(e.target.value)}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
              >
                {chains.map((c) => (
                  <option key={c.chain_id} value={c.chain_id}>
                    {c.scope === "PLATFORM" ? tx("Platform (system events)") : tenantLabel(c.tenant_id)}
                  </option>
                ))}
              </select>
            )}
          </div>

          {state === "pending" && (
            <p className="text-sm text-slate-600">
              {chain ? tx("This chain has not been verified yet. Run a verification to recompute its hashes.") : tx("No audit events have been recorded yet.")}
            </p>
          )}

          {state === "valid" && latest && (
            <p className="text-sm text-slate-600">
              {tx("{0} events re-checked{1}; every hash and link matched.", {
                0: latest.total_events_checked.toLocaleString(),
                1: checkedAll ? "" : tx(" (a bounded range)"),
              })}
            </p>
          )}

          {state === "invalid" && latest && (
            <div className="space-y-1 text-sm">
              <p className="text-rose-800">
                {tx("First problem found at event")}{" "}
                <span className="font-semibold tabular-nums">#{latest.first_invalid_sequence ?? "—"}</span>
                {" · "}
                <span className="font-mono text-xs">{latest.reason}</span>
              </p>
              <p className="text-slate-700">{describeReason(latest.reason)}</p>
              <div className="flex flex-wrap gap-3 pt-1">
                {chain && latest.first_invalid_sequence ? (
                  <button
                    type="button"
                    onClick={() => onShowEvent(chain.chain_id, latest.first_invalid_sequence as number)}
                    className="text-xs font-semibold text-rose-700 underline-offset-2 hover:underline"
                  >
                    {tx("Show this event")}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setShowDetails((v) => !v)}
                  aria-expanded={showDetails}
                  className="text-xs font-semibold text-slate-600 underline-offset-2 hover:underline"
                >
                  {showDetails ? tx("Hide diagnostic details") : tx("Diagnostic details")}
                </button>
              </div>
              {showDetails && (
                <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-slate-200 bg-white p-2 text-[11px] leading-snug text-slate-700">
                  {JSON.stringify(latest.details, null, 2)}
                </pre>
              )}
            </div>
          )}

          <dl className="flex flex-wrap gap-x-6 gap-y-1 pt-1 text-xs text-slate-500">
            {chain && (
              <div className="flex gap-1.5"><dt>{tx("Head")}</dt><dd className="tabular-nums text-slate-700">#{chain.head_sequence.toLocaleString()}</dd></div>
            )}
            {chain && (
              <div className="flex gap-1.5"><dt>{tx("Head hash")}</dt><dd className="font-mono text-slate-700" title={chain.head_hash}>{shortHash(chain.head_hash, 8)}</dd></div>
            )}
            {verifiedAt && (
              <div className="flex gap-1.5"><dt>{tx("Last checked")}</dt><dd className="text-slate-700" title={formatTime(verifiedAt)}>{relativeTime(verifiedAt)}</dd></div>
            )}
            {ops && (
              <div className="flex gap-1.5"><dt>{tx("Last event recorded")}</dt><dd className="text-slate-700" title={formatTime(ops.ledger.last_event_at)}>{relativeTime(ops.ledger.last_event_at)}</dd></div>
            )}
            {ops?.pipeline?.total_lag != null && (
              <div className="flex gap-1.5"><dt>{tx("Pipeline backlog")}</dt><dd className="tabular-nums text-slate-700">{ops.pipeline.total_lag}</dd></div>
            )}
            {ops?.dead_letters && (
              <div className="flex gap-1.5"><dt>{tx("Rejected messages")}</dt><dd className={`tabular-nums ${ops.dead_letters.count ? "text-amber-700" : "text-slate-700"}`}>{ops.dead_letters.count}</dd></div>
            )}
          </dl>
        </div>

        <div className="flex flex-col items-start gap-1 sm:items-end">
          <button
            type="button"
            onClick={onVerify}
            disabled={verifying || !chain}
            className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {verifying ? tx("Verifying…") : tx("Verify chain")}
          </button>
          {verifyError && <p role="alert" className="max-w-xs text-xs text-rose-700">{verifyError}</p>}
        </div>
      </div>

      <p className="border-t border-slate-200/70 px-4 py-2 text-[11px] leading-relaxed text-slate-500">
        {tx("This check recomputes the SHA-256 hash chain and detects edited, deleted or reordered events. On its own it cannot detect someone with full database access who rewrites the entire chain consistently; the signed checkpoints below anchor history outside the database.")}
      </p>
    </section>
  );
}
