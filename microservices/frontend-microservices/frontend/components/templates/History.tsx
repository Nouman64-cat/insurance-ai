"use client";

import { useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { describeChange, getDiff, restoreVersion, type Change, type TemplateDetail } from "@/lib/templates";

const btnGhost = "px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-slate-300 disabled:opacity-40 transition-all";
const STATE_STYLE: Record<string, string> = { published: "bg-emerald-50 text-emerald-700 border-emerald-200", superseded: "bg-slate-100 text-slate-500 border-slate-200", draft: "bg-amber-50 text-amber-700 border-amber-200" };

export default function History({ detail, onReload, onNotice }: { detail: TemplateDetail; onReload: () => void; onNotice: (n: { kind: "ok" | "error"; text: string }) => void }) {
  const numbered = detail.versions.filter((v) => v.state !== "draft");
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setFrom(numbered.length > 1 ? numbered[1].version : null);
    setTo(numbered.length > 0 ? numbered[0].version : null);
  }, [detail.key, detail.versions.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setChanges(null);
    if (from !== null && to !== null && from !== to) getDiff(detail.key, from, to).then((d) => setChanges(d.changes)).catch(() => setChanges([]));
  }, [from, to, detail.key]);

  async function restore(n: number) {
    setBusy(true);
    try { await restoreVersion(detail.key, n); onNotice({ kind: "ok", text: `${tx("Version")} ${n} ${tx("was put in the draft. Review it, then publish.")}` }); onReload(); }
    catch (e) { onNotice({ kind: "error", text: e instanceof Error ? e.message : "Could not restore." }); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <ol className="space-y-2" data-testid="versions">
        {detail.versions.map((v) => (
          <li key={`${v.version}-${v.state}`} className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <b className="text-slate-900 text-sm">{tx("Version")} {v.version}</b>
              <span className={`px-1.5 py-0.5 rounded border font-semibold ${STATE_STYLE[v.state]}`}>{v.state}</span>
              <span className="text-slate-500">{v.published_at ? new Date(v.published_at).toLocaleString() : new Date(v.updated_at).toLocaleString()}</span>
              {v.published_by && <span className="text-slate-400">{tx("by")} {v.published_by.slice(0, 8)}</span>}
              {v.state !== "draft" && <button type="button" className={`${btnGhost} ml-auto`} disabled={busy} onClick={() => restore(v.version)}>{tx("Restore into the draft")}</button>}
            </div>
            {v.change_note && <p className="mt-1 text-slate-600">{v.change_note}</p>}
          </li>
        ))}
      </ol>
      {numbered.length > 1 && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
          <h3 className="text-sm font-bold text-slate-900">{tx("Compare versions")}</h3>
          <div className="flex gap-2 items-center text-xs">
            <select className="border border-slate-200 rounded px-2 py-1" value={from ?? ""} onChange={(e) => setFrom(Number(e.target.value))} aria-label={tx("From version")}>
              {numbered.map((v) => <option key={v.version} value={v.version}>{tx("Version")} {v.version}</option>)}
            </select>
            →
            <select className="border border-slate-200 rounded px-2 py-1" value={to ?? ""} onChange={(e) => setTo(Number(e.target.value))} aria-label={tx("To version")}>
              {numbered.map((v) => <option key={v.version} value={v.version}>{tx("Version")} {v.version}</option>)}
            </select>
          </div>
          {changes === null ? <p className="text-xs text-slate-400">{from === to ? tx("Choose two different versions.") : tx("Loading…")}</p>
            : changes.length === 0 ? <p className="text-xs text-slate-500">{tx("No differences.")}</p>
              : <ul className="text-xs text-slate-600 space-y-0.5" data-testid="history-changes">{changes.map((c, i) => <li key={i}>{describeChange(c)}</li>)}</ul>}
        </section>
      )}
    </div>
  );
}
