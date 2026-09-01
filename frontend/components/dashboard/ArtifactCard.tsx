import { RingGauge, Bar, PillarCard, Divider } from "./shared";
import type { Claim } from "@/app/services/claims";

function FileCheckIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function isToday(dateStr: string): boolean {
  return dateStr.slice(0, 10) === new Date().toISOString().slice(0, 10);
}

/**
 * Document metrics here are derived from claim-level signals (artifact counts
 * per claim, and whether the claim itself was flagged) rather than a
 * per-document OCR/tamper score — this tenant's claims list doesn't expose
 * per-artifact review status yet, only a count and the parent claim's risk.
 */
export function ArtifactCard({ claims }: { claims: Claim[] }) {
  const withArtifacts = claims.filter((c) => (c.artifacts_count || 0) > 0);
  const processedToday = claims.filter((c) => isToday(c.created_at)).reduce((s, c) => s + (c.artifacts_count || 0), 0);
  const totalArtifacts = claims.reduce((s, c) => s + (c.artifacts_count || 0), 0);

  const cleanClaims = claims.filter((c) => c.fraud_probability < 0.3 && !c.duplicate_flag);
  const flaggedClaims = claims.filter((c) => c.fraud_probability >= 0.3 || c.duplicate_flag);
  const cleanDocsCount = cleanClaims.reduce((s, c) => s + (c.artifacts_count || 0), 0);
  const flaggedDocsCount = flaggedClaims.reduce((s, c) => s + (c.artifacts_count || 0), 0);

  const coveragePct = claims.length > 0 ? Math.round((withArtifacts.length / claims.length) * 1000) / 10 : 0;
  const cleanRatePct = totalArtifacts > 0 ? (cleanDocsCount / totalArtifacts) * 100 : 0;
  const flaggedRatePct = totalArtifacts > 0 ? (flaggedDocsCount / totalArtifacts) * 100 : 0;
  const avgDocsPerClaim = claims.length > 0 ? totalArtifacts / claims.length : 0;

  return (
    <PillarCard
      icon={<FileCheckIcon />}
      title="Artifact Intelligence"
      barClass="bg-blue-600"
      iconBg="bg-blue-50"
      iconColor="text-blue-600"
      alertCount={flaggedClaims.length}
    >
      {/* Coverage ring + key rates */}
      <div className="flex items-start gap-4 mb-4">
        <RingGauge value={coveragePct} max={100} strokeHex="#4f46e5" label="Document Coverage" sublabel="%" valueLabel={`${coveragePct}%`} size={82} />
        <div className="flex-1 space-y-2.5 pt-1">
          <Bar label="Clean-Claim Documents"   pct={cleanRatePct}   color="bg-blue-500" badge={`${cleanRatePct.toFixed(1)}%`} />
          <Bar label="Flagged-Claim Documents" pct={flaggedRatePct} color="bg-red-500"  badge={`${flaggedRatePct.toFixed(1)}%`} />
        </div>
      </div>

      <Divider className="mb-3" />

      {/* Count stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="text-center">
          <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">Docs Today</p>
          <p className="text-xl font-extrabold text-slate-800 mt-0.5">{processedToday}</p>
          <p className="text-[10px] text-slate-400">attached to new claims</p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">Total Docs</p>
          <p className="text-xl font-extrabold text-blue-600 mt-0.5">{totalArtifacts}</p>
          <p className="text-[10px] text-slate-400">selected range</p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">Avg / Claim</p>
          <p className="text-xl font-extrabold text-red-600 mt-0.5">{avgDocsPerClaim.toFixed(1)}</p>
          <p className="text-[10px] text-slate-400">documents</p>
        </div>
      </div>
    </PillarCard>
  );
}
