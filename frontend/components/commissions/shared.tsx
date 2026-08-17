"use client";

import React from "react";
import {
  BASIS_LABELS,
  CHANNEL_LABELS,
  CommissionBasis,
  CommissionEntryKind,
  CommissionStatus,
  DistributionChannel,
  PAYEE_TYPE_LABELS,
  PayeeType,
  ReleaseStage,
  ReleaseStageCode,
  StageStatus,
} from "../../app/services/commissions";

export const fmtPKR = (val: number) =>
  new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", maximumFractionDigits: 0 }).format(val);

/**
 * Dashboard-scale money. Nine-digit rupee figures side by side are unreadable,
 * so headline numbers are abbreviated and carry the exact value in a tooltip.
 */
export const fmtPKRCompact = (val: number) => {
  const abs = Math.abs(val);
  const sign = val < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}Rs ${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}Rs ${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}Rs ${(abs / 1_000).toFixed(0)}K`;
  return fmtPKR(val);
};

export const fmtPKRSigned = (val: number) => (val < 0 ? `- ${fmtPKR(Math.abs(val))}` : fmtPKR(val));

export const fmtPct = (val: number) => `${Number.isInteger(val) ? val : val.toFixed(2)}%`;

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-white rounded-xl border border-slate-200/80 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${className}`}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 h-14 border-b border-slate-100">
          <div className="min-w-0">
            {title && <h2 className="text-[13px] font-semibold text-slate-900 tracking-tight">{title}</h2>}
            {subtitle && <p className="text-[11px] text-slate-500 mt-0.5 truncate">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * Headline figure. One accent colour carries meaning (blue = actionable now,
 * emerald = settled, amber = needs attention); everything else stays neutral so
 * the eye lands on the number rather than on the decoration.
 */
export function MetricTile({
  label,
  value,
  hint,
  exact,
  tone = "slate",
}: {
  label: string;
  value: string;
  hint?: string;
  /** Full-precision value shown on hover when `value` is abbreviated. */
  exact?: string;
  tone?: "slate" | "blue" | "amber" | "emerald";
}) {
  const tones = {
    slate: { dot: "bg-slate-300", value: "text-slate-900" },
    blue: { dot: "bg-blue-500", value: "text-blue-700" },
    amber: { dot: "bg-amber-500", value: "text-slate-900" },
    emerald: { dot: "bg-emerald-500", value: "text-slate-900" },
  }[tone];

  return (
    <div className="bg-white px-4 py-3.5 rounded-xl border border-slate-200/80 shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:border-slate-300 transition-colors">
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${tones.dot}`} />
        <span className="text-[11px] font-medium text-slate-500 truncate">{label}</span>
      </div>
      <p title={exact} className={`mt-1.5 text-[22px] leading-none font-semibold tabular-nums tracking-tight ${tones.value}`}>
        {value}
      </p>
      {hint && <p className="mt-1.5 text-[11px] text-slate-400 truncate">{hint}</p>}
    </div>
  );
}

/**
 * Status colour is semantic, not decorative: neutral while nothing is owed,
 * blue once money is actionable, green when it has settled, amber/red only when
 * a human needs to intervene. Nothing else on the page competes for those hues.
 */
const STATUS_STYLES: Record<CommissionStatus, string> = {
  ACCRUED: "bg-slate-50 text-slate-600 border-slate-200",
  PAYABLE: "bg-blue-50 text-blue-700 border-blue-200",
  IN_RUN: "bg-blue-600 text-white border-blue-600",
  PARTIALLY_RELEASED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  DISBURSED: "bg-emerald-600 text-white border-emerald-600",
  HELD: "bg-amber-50 text-amber-800 border-amber-200",
  CLAWED_BACK: "bg-rose-50 text-rose-700 border-rose-200",
};

const STATUS_LABELS: Record<CommissionStatus, string> = {
  ACCRUED: "Accrued",
  PAYABLE: "Due",
  IN_RUN: "In run",
  PARTIALLY_RELEASED: "Part-paid",
  DISBURSED: "Paid",
  HELD: "Held",
  CLAWED_BACK: "Reversed",
};

export function StatusPill({ status, title }: { status: CommissionStatus; title?: string }) {
  return (
    <span
      title={title}
      className={`px-2 py-0.5 rounded-md text-[10px] font-semibold border inline-block whitespace-nowrap ${title ? "cursor-help" : ""} ${STATUS_STYLES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

/**
 * Payee types are a taxonomy, not a severity scale — giving each one its own hue
 * turns the table into confetti. Internal roles read in the accent family,
 * external counterparties in neutral, and the label carries the meaning.
 */
const PAYEE_TYPE_STYLES: Record<PayeeType, string> = {
  AGENT: "bg-blue-50 text-blue-700 border-blue-100",
  SALES_MANAGER: "bg-blue-50/60 text-blue-600 border-blue-100",
  BRANCH_MANAGER: "bg-blue-50/60 text-blue-600 border-blue-100",
  AGENCY: "bg-slate-50 text-slate-600 border-slate-200",
  BROKER: "bg-slate-50 text-slate-600 border-slate-200",
  BANK_PARTNER: "bg-slate-50 text-slate-600 border-slate-200",
  BANK_SALES_OFFICER: "bg-slate-50 text-slate-600 border-slate-200",
  REFERRAL_PARTNER: "bg-slate-50 text-slate-600 border-slate-200",
  HOUSE: "bg-slate-100 text-slate-500 border-slate-200",
};

export function PayeeTypeBadge({ type }: { type: PayeeType }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border whitespace-nowrap ${PAYEE_TYPE_STYLES[type]}`}>
      {PAYEE_TYPE_LABELS[type]}
    </span>
  );
}

export function ChannelBadge({ channel }: { channel: DistributionChannel }) {
  return (
    <span className="px-2 py-0.5 rounded text-[10px] font-semibold border bg-slate-50 text-slate-700 border-slate-200 whitespace-nowrap">
      {CHANNEL_LABELS[channel]}
    </span>
  );
}

const ENTRY_KIND_LABELS: Record<CommissionEntryKind, string> = {
  COMMISSION: "Commission",
  OVERRIDE: "Override",
  PARTNER_FEE: "Partner fee",
  REFERRAL_FEE: "Referral fee",
  BONUS: "Bonus",
  CLAWBACK: "Clawback",
};

/** Entry kind is a label, not an alarm — only a reversal earns a warning colour. */
const ENTRY_KIND_STYLES: Record<CommissionEntryKind, string> = {
  COMMISSION: "bg-slate-50 text-slate-600 border-slate-200",
  OVERRIDE: "bg-slate-50 text-slate-600 border-slate-200",
  PARTNER_FEE: "bg-slate-50 text-slate-600 border-slate-200",
  REFERRAL_FEE: "bg-slate-50 text-slate-600 border-slate-200",
  BONUS: "bg-blue-50 text-blue-700 border-blue-100",
  CLAWBACK: "bg-rose-50 text-rose-700 border-rose-200",
};

export function EntryKindBadge({ kind }: { kind: CommissionEntryKind }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border whitespace-nowrap ${ENTRY_KIND_STYLES[kind]}`}>
      {ENTRY_KIND_LABELS[kind]}
    </span>
  );
}

export function BasisLabel({ basis, amount }: { basis: CommissionBasis; amount: number }) {
  return (
    <div className="leading-tight">
      <p className="text-[10px] font-semibold text-slate-600">{BASIS_LABELS[basis]}</p>
      <p className="text-[10px] font-mono text-slate-400">{fmtPKR(amount)}</p>
    </div>
  );
}

/** Licence state with an at-a-glance colour: expired licences block payout. */
export function LicenceCell({ licenceNo, expiry }: { licenceNo: string | null; expiry: string | null }) {
  if (!licenceNo) return <span className="text-[10px] text-slate-400">Not licensed / not required</span>;

  const today = new Date().toISOString().slice(0, 10);
  const expired = !!expiry && expiry < today;
  const soon =
    !!expiry && !expired && new Date(expiry).getTime() - Date.now() < 90 * 86_400_000;

  return (
    <div className="leading-tight">
      <p className="font-mono text-[10px] font-bold text-slate-700">{licenceNo}</p>
      <p
        className={`text-[10px] font-semibold ${expired ? "text-rose-600" : soon ? "text-amber-600" : "text-slate-400"}`}
      >
        {expired ? `Expired ${expiry}` : soon ? `Expires ${expiry}` : `Valid to ${expiry}`}
      </p>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-700 mb-1">{label}</label>
      {children}
    </div>
  );
}

/**
 * Button scale. Weight signals precedence — dark for the committing action,
 * outline for everything reversible — rather than each action picking a colour.
 */
export const btnPrimary =
  "px-3 py-1.5 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400 text-white text-[11px] font-medium rounded-lg transition-colors";

export const btnAccent =
  "px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-medium rounded-lg transition-colors";

export const btnGhost =
  "px-3 py-1.5 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 text-[11px] font-medium rounded-lg transition-colors";

export const btnDanger =
  "px-3 py-1.5 bg-white border border-slate-200 text-rose-700 hover:bg-rose-50 hover:border-rose-200 text-[11px] font-medium rounded-lg transition-colors";

export const inputClass =
  "w-full p-2 border border-slate-300 rounded-xl text-xs text-slate-900 focus:outline-hidden focus:border-blue-500";

export const selectClass =
  "w-full p-2 border border-slate-300 rounded-xl text-xs text-slate-900 bg-white focus:outline-hidden focus:border-blue-500";

export function EmptyState({ message }: { message: string }) {
  return <div className="px-5 py-10 text-center text-xs text-slate-400">{message}</div>;
}

/** A gating checklist — why an entry is or isn't releasable. */
export function GatingList({
  checks,
}: {
  checks: { code: string; label: string; passed: boolean; detail: string }[];
}) {
  if (checks.length === 0) return <p className="text-[10px] text-slate-400">No gating checks recorded.</p>;
  return (
    <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
      {checks.map((c) => (
        <li key={c.code} className="flex items-start gap-1.5 text-[10px]">
          <span
            className={`mt-0.5 w-3.5 h-3.5 shrink-0 rounded-full flex items-center justify-center text-[8px] font-semibold ${
              c.passed ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"
            }`}
          >
            {c.passed ? "✓" : "✕"}
          </span>
          <span>
            <span className="font-bold text-slate-700">{c.label}</span>
            <span className="text-slate-500"> — {c.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// ── Release stages ──────────────────────────────────────────────────────────

const STAGE_STATUS_STYLES: Record<StageStatus, { pill: string; dot: string; label: string }> = {
  PENDING: { pill: "bg-slate-50 text-slate-600 border-slate-200", dot: "bg-slate-300", label: "Not yet due" },
  BLOCKED: { pill: "bg-amber-50 text-amber-800 border-amber-200", dot: "bg-amber-400", label: "Blocked" },
  DUE: { pill: "bg-blue-50 text-blue-700 border-blue-200", dot: "bg-blue-500", label: "Due now" },
  IN_RUN: { pill: "bg-indigo-50 text-indigo-700 border-indigo-200", dot: "bg-indigo-500", label: "In payout run" },
  RELEASED: { pill: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500", label: "Released" },
  REVERSED: { pill: "bg-rose-50 text-rose-700 border-rose-200", dot: "bg-rose-400", label: "Reversed" },
};

export function StageStatusPill({ status }: { status: StageStatus }) {
  const style = STAGE_STATUS_STYLES[status];
  return (
    <span className={`px-2 py-0.5 rounded text-[10px] font-bold border whitespace-nowrap ${style.pill}`}>
      {style.label}
    </span>
  );
}

/**
 * A commission's release schedule drawn as a track: each tranche's share of the
 * entry, what it is waiting on, and how much of it is money already out.
 */
export function StageTimeline({
  stages,
  onRelease,
  compact = false,
}: {
  stages: ReleaseStage[];
  onRelease?: (code: ReleaseStageCode) => void;
  compact?: boolean;
}) {
  if (stages.length === 0) return <p className="text-[10px] text-slate-400">No release schedule on this entry.</p>;

  return (
    <div className="space-y-2">
      {/* Proportional bar: the whole commission, coloured by where each slice is. */}
      <div className="flex h-2 w-full rounded-full overflow-hidden bg-slate-100">
        {stages.map((s) => (
          <div
            key={s.code}
            title={`${s.label} — ${s.sharePct}% · ${STAGE_STATUS_STYLES[s.status].label}`}
            className={STAGE_STATUS_STYLES[s.status].dot}
            style={{ width: `${s.sharePct}%` }}
          />
        ))}
      </div>

      <ol className={`grid gap-1.5 ${compact ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2"}`}>
        {stages.map((s) => (
          <li key={s.code} className="flex items-start gap-2 text-[10px]">
            <span className={`mt-1 w-2 h-2 shrink-0 rounded-full ${STAGE_STATUS_STYLES[s.status].dot}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-bold text-slate-800">{s.label}</span>
                <span className="font-mono text-slate-400">{s.sharePct}%</span>
                <span className="font-mono font-bold text-slate-700">{fmtPKR(s.netAmount)}</span>
                <StageStatusPill status={s.status} />
                {onRelease && s.status === "DUE" && (
                  <button
                    onClick={() => onRelease(s.code)}
                    className="px-1.5 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-bold text-[9px]"
                  >
                    Release
                  </button>
                )}
              </div>
              <p className="text-slate-500 truncate" title={s.reason}>
                {s.reason}
                {s.releasedAt ? ` · paid ${s.releasedAt}` : ""}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Due / in-run / not-yet-due split for one entry or one policy. */
export function DueBreakdown({
  dueNet,
  inRunNet,
  pendingNet,
  releasedNet,
}: {
  dueNet: number;
  inRunNet: number;
  pendingNet: number;
  releasedNet: number;
}) {
  return (
    <div className="leading-tight text-right">
      {dueNet > 0 && <p className="font-semibold tabular-nums text-blue-700">{fmtPKR(dueNet)} due</p>}
      {inRunNet > 0 && <p className="font-mono text-[10px] text-indigo-600">{fmtPKR(inRunNet)} in run</p>}
      {releasedNet > 0 && <p className="font-mono text-[10px] text-emerald-600">{fmtPKR(releasedNet)} paid</p>}
      {pendingNet > 0 && <p className="font-mono text-[10px] text-slate-400">{fmtPKR(pendingNet)} later</p>}
      {dueNet === 0 && inRunNet === 0 && releasedNet === 0 && pendingNet === 0 && (
        <p className="font-mono text-[10px] text-slate-300">—</p>
      )}
    </div>
  );
}
