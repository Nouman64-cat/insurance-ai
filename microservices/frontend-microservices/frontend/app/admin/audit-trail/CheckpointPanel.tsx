"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import {
  ANCHOR_HELP, ANCHOR_LABEL, AnchoredResult, AnchoredRun, ChainProgress, Checkpoint, CheckpointStatus, CheckpointVerification, Tone,
  anchorTone, checkpointApi, errorMessage, formatDuration, formatTime, relativeTime, shortHash,
} from "@/lib/audit";

const TONE: Record<Tone, { dot: string; text: string }> = {
  good: { dot: "bg-emerald-500", text: "text-emerald-700" },
  bad: { dot: "bg-rose-500", text: "text-rose-700" },
  wait: { dot: "bg-amber-500", text: "text-amber-700" },
  neutral: { dot: "bg-slate-300", text: "text-slate-500" },
};
const SEVERITY_DOT = { CRITICAL: "bg-rose-500", WARNING: "bg-amber-500", INFO: "bg-slate-300" } as const;
const PAGE_SIZE = 8;

function Indicator({ label, value, tone, hint }: { label: string; value: string; tone: Tone; hint: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5" title={hint}>
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{tx(label)}</p>
      <p className={`mt-1 flex items-center gap-1.5 text-sm font-semibold ${TONE[tone].text}`}>
        <span className={`h-2 w-2 rounded-full ${TONE[tone].dot}`} aria-hidden="true" />
        {tx(value)}
      </p>
    </div>
  );
}

const yesNo = (v: boolean | null, yes: string, no: string, unknown = "Not checked yet"): [string, Tone] =>
  v === null ? [unknown, "neutral"] : v ? [yes, "good"] : [no, "bad"];

interface Props {
  chainId: string;
  isSuperAdmin: boolean;
}

export default function CheckpointPanel({ chainId, isSuperAdmin }: Props) {
  const [status, setStatus] = useState<CheckpointStatus | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [items, setItems] = useState<Checkpoint[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [runs, setRuns] = useState<AnchoredRun[]>([]);
  const [result, setResult] = useState<AnchoredResult | null>(null);
  const [busy, setBusy] = useState<"" | "verify" | "create" | "rotate">("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [single, setSingle] = useState<Record<string, CheckpointVerification | "loading">>({});
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, Checkpoint>>({});
  const [error, setError] = useState("");

  const progress: ChainProgress | undefined = useMemo(() => status?.chains.find((c) => c.chain_id === chainId), [status, chainId]);

  const refresh = useCallback(async () => {
    try {
      setStatus(await checkpointApi.status());
      setFetchedAt(Date.now());
      setError("");
    } catch (err) {
      setError(errorMessage(err, tx("Could not load checkpoint status.")));
    }
  }, []);

  const loadList = useCallback(async () => {
    if (!chainId) { setItems([]); setTotal(0); return; }
    try {
      const [list, history] = await Promise.all([checkpointApi.list(chainId, page, PAGE_SIZE), checkpointApi.history(chainId)]);
      setItems(list.items);
      setTotal(list.total);
      setRuns(history);
    } catch { /* the status request reports availability problems */ }
  }, [chainId, page]);

  useEffect(() => { refresh(); const t = setInterval(refresh, 15000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { setPage(1); setResult(null); setMessage(null); setOpen(null); }, [chainId]);
  useEffect(() => { loadList(); }, [loadList, status?.chains.find((c) => c.chain_id === chainId)?.last_checkpoint_number]);

  const latest = result ?? runs[0] ?? null;
  const countdown = progress?.seconds_until_interval == null ? null : Math.max(0, progress.seconds_until_interval - (now - fetchedAt) / 1000);
  const pct = progress ? Math.min(100, Math.round((progress.pending_events / Math.max(1, progress.event_threshold)) * 100)) : 0;
  const lastCheckpoint = items[0];

  const act = async (kind: "verify" | "create" | "rotate") => {
    if (kind === "rotate" && !window.confirm(tx("Rotate the signing key? New checkpoints will be signed with a new key. Older checkpoints stay valid against the old public key."))) return;
    setBusy(kind);
    setMessage(null);
    try {
      if (kind === "verify") setResult(await checkpointApi.verifyChain(chainId));
      if (kind === "create") {
        const r = await checkpointApi.create(chainId);
        setMessage({ ok: r.status === "CREATED" || r.status === "NOTHING_PENDING", text: r.status === "CREATED" ? tx("Checkpoint created.") : r.status === "NOTHING_PENDING" ? tx("There are no new events to checkpoint.") : `${r.error_code ?? r.status}: ${r.error ?? ""}` });
      }
      if (kind === "rotate") {
        const key = await checkpointApi.rotate();
        setMessage({ ok: true, text: tx("Signing key rotated: now using key version {0}.", { 0: key.key_version }) });
      }
      await Promise.all([refresh(), loadList()]);
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err, tx("The action could not be completed.")) });
    } finally {
      setBusy("");
    }
  };

  const verifyOne = async (id: string) => {
    setSingle((s) => ({ ...s, [id]: "loading" }));
    try {
      const r = await checkpointApi.verifyOne(id);
      setSingle((s) => ({ ...s, [id]: r }));
    } catch (err) {
      setSingle((s) => { const { [id]: _drop, ...rest } = s; return rest; });
      setMessage({ ok: false, text: errorMessage(err, tx("Verification failed.")) });
    }
  };

  const toggle = async (id: string) => {
    const next = open === id ? null : id;
    setOpen(next);
    if (next && !detail[next]) {
      try { const d = await checkpointApi.detail(next); setDetail((m) => ({ ...m, [next]: d })); } catch { /* shown without detail */ }
    }
  };

  if (!status) {
    return error ? <p role="alert" className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">{error}</p> : null;
  }

  const sig = yesNo(latest ? latest.signatures_valid : null, "Valid", "Invalid");
  const signer = yesNo(latest ? latest.signer_trusted : null, "Trusted", "Untrusted");
  const anchor = yesNo(latest ? latest.anchored : null, "Anchored", "Not anchored");
  const chainOk = yesNo(latest ? latest.hash_chain_valid : null, "Intact", "Broken");
  const pending = latest ? latest.pending_events : progress?.pending_events ?? 0;
  const signerProblem = typeof status.signer?.problem === "string" ? status.signer.problem : status.signer && status.signer.problem === true ? tx("The signer reports a problem.") : "";
  const activeKey = status.signer?.active_key ?? status.registry?.keys.find((k) => k.status === "ACTIVE");
  const openAlerts = status.alerts.filter((a) => a.open).slice(0, 4);
  const resolvedAlerts = status.alerts.filter((a) => a.severity !== "INFO" && !a.open).length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section aria-label={tx("Signed checkpoints")} className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">{tx("Signed checkpoints")}</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {tx("Ed25519-signed anchors, stored outside the database. They let verification catch a rewritten history that the hash chain alone cannot.")}
            {" "}<span className="text-slate-400">· {status.environment_label}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => act("verify")} disabled={!!busy || !chainId || !status.signing_enabled}
            className="rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50">
            {busy === "verify" ? tx("Verifying…") : tx("Verify signatures & anchors")}
          </button>
          {isSuperAdmin && (
            <>
              <button type="button" onClick={() => act("create")} disabled={!!busy || !chainId || !status.signing_enabled}
                className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                {busy === "create" ? tx("Creating…") : tx("Create checkpoint now")}
              </button>
              <button type="button" onClick={() => act("rotate")} disabled={!!busy || !status.signing_enabled}
                className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                {busy === "rotate" ? tx("Rotating…") : tx("Rotate signing key")}
              </button>
            </>
          )}
        </div>
      </div>

      {message && <p role="status" className={`text-xs ${message.ok ? "text-emerald-700" : "text-rose-700"}`}>{message.text}</p>}

      {!status.signing_enabled ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
          {tx("Checkpoint signing is turned off for this installation. The hash chain above is still verified, but nothing is anchored outside the database.")}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Indicator label="Hash chain integrity" value={chainOk[0]} tone={chainOk[1]} hint={tx("SHA-256 chain of events (Stage 1)")} />
            <Indicator label="Digital signatures" value={sig[0]} tone={sig[1]} hint={tx("Ed25519 signatures on the checkpoints")} />
            <Indicator label="Trusted anchor" value={latest ? (latest.anchored && latest.signer_trusted ? "Anchored to trusted checkpoints" : anchor[0]) : "Not checked yet"}
              tone={latest ? (latest.anchored && latest.signer_trusted ? "good" : anchor[1] === "good" ? signer[1] : anchor[1]) : "neutral"}
              hint={tx("Signed by a trusted key and matching the independently stored copy")} />
            <Indicator label="Pending unsigned events" value={pending === 0 ? "None" : `${pending.toLocaleString()} ${tx("not yet signed")}`} tone={pending === 0 ? "good" : "wait"}
              hint={tx("Events recorded after the newest checkpoint")} />
          </div>

          {latest && (
            <div className={`rounded-lg border p-3 text-xs ${TONE[anchorTone(latest.state)].text} ${anchorTone(latest.state) === "bad" ? "border-rose-200 bg-rose-50/60" : anchorTone(latest.state) === "wait" ? "border-amber-200 bg-amber-50/50" : "border-emerald-200 bg-emerald-50/50"}`}>
              <p className="font-semibold">{tx(ANCHOR_LABEL[latest.state])} <span className="font-normal text-slate-500">· {relativeTime(latest.verified_at)}</span></p>
              <p className="mt-0.5 text-slate-600">{tx(ANCHOR_HELP[latest.state])}</p>
              {latest.findings.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 ps-4 text-slate-700">
                  {latest.findings.slice(0, 6).map((f, i) => (
                    <li key={i}><span className="font-mono text-[11px]">{f.code}</span>{f.checkpoint_number ? ` (#${f.checkpoint_number})` : ""}: {f.message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-slate-200 p-3">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">{tx("Last signed checkpoint")}</p>
              {progress?.last_checkpoint_number ? (
                <p className="mt-1 text-sm text-slate-800">
                  <span className="font-semibold">#{progress.last_checkpoint_number}</span>{" "}
                  <span className="text-slate-500">· {formatTime(progress.last_checkpoint_at)}</span>
                  <span className="block text-xs text-slate-500">
                    {lastCheckpoint ? tx("events {0}–{1} · signed with key v{2}", { 0: lastCheckpoint.start_sequence.toLocaleString(), 1: lastCheckpoint.end_sequence.toLocaleString(), 2: lastCheckpoint.key_version }) : ""}
                  </span>
                </p>
              ) : <p className="mt-1 text-sm text-slate-500">{tx("No checkpoint has been signed for this chain yet.")}</p>}
              <p className="mt-2 text-xs text-slate-500">
                {tx("Signing key")}: {activeKey ? <span className="text-slate-700">v{activeKey.key_version} · <span className="font-mono">{shortHash(activeKey.fingerprint, 8)}</span></span> : <span className="text-rose-700">{tx("none available")}</span>}
              </p>
              {signerProblem && <p role="alert" className="mt-1 text-xs text-rose-700">{signerProblem}</p>}
              {status.registry && !status.registry.ok && <p role="alert" className="mt-1 text-xs text-rose-700">{status.registry.problem}</p>}
              {!status.storage_available && <p role="alert" className="mt-1 text-xs text-rose-700">{tx("The protected checkpoint store cannot be reached.")}</p>}
            </div>

            <div className="rounded-lg border border-slate-200 p-3">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">{tx("Next checkpoint")}</p>
              {progress && progress.pending_events > 0 ? (
                <>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={progress.event_threshold} aria-valuenow={Math.min(progress.pending_events, progress.event_threshold)} aria-label={tx("Events toward the next checkpoint")}>
                    <div className="h-full rounded-full bg-slate-700" style={{ width: `${Math.max(pct, 2)}%` }} />
                  </div>
                  <p className="mt-1.5 text-xs text-slate-600 tabular-nums">
                    {tx("{0} of {1} events", { 0: progress.pending_events.toLocaleString(), 1: progress.event_threshold.toLocaleString() })}
                    {" · "}
                    {progress.due ? <span className="font-semibold text-amber-700">{tx("due now")}</span> : tx("or in {0}", { 0: formatDuration(countdown) })}
                  </p>
                  {progress.failures > 0 && (
                    <p role="alert" className="mt-1 text-xs text-rose-700">
                      {tx("Checkpointing has failed {0} time(s); retrying automatically.", { 0: progress.failures })} {progress.last_error}
                    </p>
                  )}
                </>
              ) : <p className="mt-1 text-sm text-slate-500">{tx("Nothing waiting: every recorded event is covered by a signed checkpoint.")}</p>}
              <p className="mt-2 text-[11px] text-slate-400">{tx("A checkpoint is created after {0} new events or {1} minutes, whichever comes first.", { 0: progress?.event_threshold ?? 500, 1: Math.round((progress?.interval_seconds ?? 900) / 60) })}</p>
            </div>
          </div>

          {openAlerts.length === 0 && resolvedAlerts > 0 && (
            <p className="text-[11px] text-slate-400">{tx("No open alerts. {0} earlier alert(s) were resolved; they remain in the audit record.", { 0: resolvedAlerts })}</p>
          )}

          {openAlerts.length > 0 && (
            <ul aria-label={tx("Checkpoint alerts")} className="space-y-1 rounded-lg border border-rose-200 bg-rose-50/40 p-3 text-xs text-slate-700">
              {openAlerts.map((a) => (
                <li key={a.id} className="flex items-start gap-2">
                  <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[a.severity]}`} aria-hidden="true" />
                  <span><span className="font-mono text-[11px]">{a.kind}</span> · {a.message} <span className="text-slate-400">· {relativeTime(a.raised_at)}</span></span>
                </li>
              ))}
            </ul>
          )}

          <div>
            <h3 className="mb-2 text-xs font-semibold text-slate-700">{tx("Checkpoint history")}</h3>
            {items.length === 0 ? <p className="text-xs text-slate-500">{tx("No signed checkpoints yet.")}</p> : (
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="min-w-full text-left text-xs">
                  <caption className="sr-only">{tx("Signed checkpoints, newest first")}</caption>
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                    <tr>
                      <th scope="col" className="px-3 py-2 text-right font-medium">#</th>
                      <th scope="col" className="px-3 py-2 font-medium">{tx("Created")}</th>
                      <th scope="col" className="px-3 py-2 font-medium">{tx("Events")}</th>
                      <th scope="col" className="px-3 py-2 font-medium">{tx("Key")}</th>
                      <th scope="col" className="px-3 py-2 font-medium">{tx("Status")}</th>
                      <th scope="col" className="px-3 py-2 font-medium">{tx("Verification")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((c) => {
                      const v = single[c.checkpoint_id];
                      const d = detail[c.checkpoint_id];
                      return (
                        <Fragment key={c.checkpoint_id}>
                          <tr className="hover:bg-slate-50">
                            <td className="px-3 py-2 text-right tabular-nums">
                              <button type="button" aria-expanded={open === c.checkpoint_id} onClick={() => toggle(c.checkpoint_id)} className="font-semibold text-slate-800 underline-offset-2 hover:underline">{c.checkpoint_number}</button>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-slate-600">{formatTime(c.created_at)}</td>
                            <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-700">{c.start_sequence.toLocaleString()}–{c.end_sequence.toLocaleString()} <span className="text-slate-400">({c.event_count.toLocaleString()})</span></td>
                            <td className="whitespace-nowrap px-3 py-2 text-slate-700">v{c.key_version} <span className="text-slate-400">{c.signature_algorithm}</span></td>
                            <td className="px-3 py-2"><span className="inline-flex items-center gap-1.5 text-slate-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />{tx("Signed · stored")}</span></td>
                            <td className="px-3 py-2">
                              {v && v !== "loading" ? (
                                <span className={`font-semibold ${TONE[anchorTone(v.state)].text}`} title={v.findings.map((f) => f.message).join(" · ")}>{tx(ANCHOR_LABEL[v.state])}</span>
                              ) : (
                                <button type="button" disabled={v === "loading"} onClick={() => verifyOne(c.checkpoint_id)} className="rounded border border-slate-300 px-2 py-0.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                                  {v === "loading" ? tx("Checking…") : tx("Verify signature")}
                                </button>
                              )}
                            </td>
                          </tr>
                          {open === c.checkpoint_id && (
                            <tr className="bg-slate-50/70">
                              <td colSpan={6} className="space-y-2 px-4 py-3">
                                {v && v !== "loading" && (
                                  <p className="text-slate-600">
                                    {tx("Signature")}: <b className={v.signature_valid ? "text-emerald-700" : "text-rose-700"}>{v.signature_valid ? tx("valid") : tx("invalid")}</b>
                                    {" · "}{tx("Signer")}: <b className={v.signer_trusted ? "text-emerald-700" : "text-rose-700"}>{v.signer_trusted ? tx("trusted") : tx("untrusted")}</b>
                                    {" · "}{tx("Protected copy")}: <b className={v.stored_copy_matches ? "text-emerald-700" : "text-rose-700"}>{v.stored_copy_matches ? tx("matches") : tx("differs or missing")}</b>
                                  </p>
                                )}
                                <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
                                  <dt className="text-slate-500">{tx("Checkpoint hash")}</dt><dd className="break-all font-mono text-[11px]">{c.checkpoint_hash}</dd>
                                  <dt className="text-slate-500">{tx("Last event hash")}</dt><dd className="break-all font-mono text-[11px]">{c.last_event_hash}</dd>
                                  <dt className="text-slate-500">{tx("Previous checkpoint")}</dt><dd className="break-all font-mono text-[11px]">{c.previous_checkpoint_hash}</dd>
                                  <dt className="text-slate-500">{tx("Signature")}</dt><dd className="break-all font-mono text-[11px]">{c.signature}</dd>
                                  <dt className="text-slate-500">{tx("Signing key")}</dt><dd className="font-mono text-[11px]">{c.signing_key_id}</dd>
                                  <dt className="text-slate-500">{tx("Protected copy")}</dt><dd className="font-mono text-[11px]">{c.storage_path}</dd>
                                </dl>
                                {d?.canonical_payload && (
                                  <details>
                                    <summary className="cursor-pointer text-slate-600">{tx("Signed payload (canonical)")}</summary>
                                    <pre className="mt-1 max-h-40 overflow-auto rounded border border-slate-200 bg-white p-2 text-[11px] leading-snug">{d.canonical_payload}</pre>
                                  </details>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {total > PAGE_SIZE && (
              <div className="mt-2 flex items-center justify-end gap-3 text-xs text-slate-500">
                <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border border-slate-300 px-2.5 py-1 font-semibold text-slate-700 disabled:opacity-40">{tx("Previous")}</button>
                <span className="tabular-nums">{tx("Page {0} of {1}", { 0: page, 1: pages })}</span>
                <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)} className="rounded border border-slate-300 px-2.5 py-1 font-semibold text-slate-700 disabled:opacity-40">{tx("Next")}</button>
              </div>
            )}
          </div>

          {runs.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-semibold text-slate-700">{tx("Verification history")}</h3>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-xs">
                {runs.map((r) => (
                  <li key={r.run_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
                    <span className={`flex items-center gap-1.5 font-semibold ${TONE[anchorTone(r.state)].text}`}><span className={`h-1.5 w-1.5 rounded-full ${TONE[anchorTone(r.state)].dot}`} aria-hidden="true" />{tx(ANCHOR_LABEL[r.state])}</span>
                    <span className="text-slate-500">{formatTime(r.verified_at)} · {r.trigger === "SCHEDULED" ? tx("scheduled") : tx("on demand")} · {tx("{0} checkpoint(s)", { 0: r.checkpoints_checked })}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-slate-400">
            {tx("Signed checkpoints protect history up to the newest checkpoint against anyone who can change the database but does not hold the signing key. They do not protect against someone who controls the signing service and its key, and events newer than the last checkpoint are not anchored yet.")}
          </p>
        </>
      )}
    </section>
  );
}
