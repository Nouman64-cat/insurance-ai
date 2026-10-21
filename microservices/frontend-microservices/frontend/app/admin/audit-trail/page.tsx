"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "@/app/services/api";
import { tx } from "@/lib/i18n/tx";
import {
  AuditEvent, ChainSummary, EMPTY_FILTERS, EventFilters, Facets, OpsStatus, SequenceInfo, VerificationResult,
  auditApi, errorMessage,
} from "@/lib/audit";
import ArchivePanel from "./ArchivePanel";
import CheckpointPanel from "./CheckpointPanel";
import EventDrawer from "./EventDrawer";
import MissingEventDrawer from "./MissingEventDrawer";
import RecycleBinDrawer from "./RecycleBinDrawer";
import EventTable from "./EventTable";
import Filters from "./Filters";
import IntegrityPanel from "./IntegrityPanel";

const PAGE_SIZES = [25, 50, 100];

export default function AuditTrailPage() {
  const [role, setRole] = useState<string | null>(null);
  const [filters, setFilters] = useState<EventFilters>(EMPTY_FILTERS);
  const [debouncedFilters, setDebouncedFilters] = useState<EventFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [facets, setFacets] = useState<Facets | null>(null);
  const [chains, setChains] = useState<ChainSummary[]>([]);
  const [chainId, setChainId] = useState("");
  const [ops, setOps] = useState<OpsStatus | null>(null);
  const [verification, setVerification] = useState<Record<string, VerificationResult>>({});
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [missing, setMissing] = useState<SequenceInfo | null>(null);
  const [demo, setDemo] = useState(false);       // ENV_VAR=demo on the audit service: delete/restore test tools
  const [binOpen, setBinOpen] = useState(false);
  const [tenantNames, setTenantNames] = useState<Record<string, string>>({});
  const requestSeq = useRef(0);

  useEffect(() => { setRole(localStorage.getItem("user_role") ?? ""); }, []);
  const isSuperAdmin = role === "SuperAdmin";
  const authorized = isSuperAdmin;   // the audit trail is platform-administrator only (matches AUDIT_READ_ROLES on the audit service)

  // Debounce typing in the text filters; everything else applies at once.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedFilters(filters), 300);
    return () => clearTimeout(t);
  }, [filters]);
  useEffect(() => { setPage(1); }, [debouncedFilters, pageSize]);

  const tenantLabel = useCallback(
    (id: string | null) => (id ? tenantNames[id] ?? `${tx("Tenant")} ${id.slice(0, 8)}` : tx("Platform")),
    [tenantNames],
  );

  const loadSummary = useCallback(async () => {
    try {
      const [list, status] = await Promise.all([auditApi.chains(), auditApi.status().catch(() => null)]);
      setChains(list);
      setOps(status);
      setChainId((current) => (list.some((c) => c.chain_id === current) ? current : list[0]?.chain_id ?? ""));
    } catch { /* the events request reports access and availability problems */ }
  }, []);

  // Pick up scheduled verification results (and new events) without a page reload.
  useEffect(() => {
    if (!authorized) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") loadSummary(); }, 60_000);
    return () => clearInterval(timer);
  }, [authorized, loadSummary]);

  useEffect(() => {
    if (!authorized) return;
    loadSummary();
    auditApi.facets().then(setFacets).catch(() => undefined);
    auditApi.demoEnabled().then(setDemo).catch(() => setDemo(false));
    if (isSuperAdmin) {
      api.get<Array<{ id: string; name: string }>>("/tenants").then((r) => {
        setTenantNames(Object.fromEntries(r.data.map((t) => [t.id, t.name])));
      }).catch(() => undefined);
    }
  }, [authorized, isSuperAdmin, loadSummary]);

  const loadEvents = useCallback(async () => {
    const mine = ++requestSeq.current;
    setLoading(true);
    setError("");
    try {
      const result = await auditApi.events(debouncedFilters, page, pageSize);
      if (mine !== requestSeq.current) return; // a newer request superseded this one
      setEvents(result.items);
      setTotal(result.total);
    } catch (err) {
      if (mine !== requestSeq.current) return;
      setEvents([]);
      setTotal(0);
      setError(errorMessage(err, tx("Could not load the audit trail.")));
    } finally {
      if (mine === requestSeq.current) setLoading(false);
    }
  }, [debouncedFilters, page, pageSize]);

  useEffect(() => { if (authorized) loadEvents(); }, [authorized, loadEvents]);

  const chain = useMemo(() => chains.find((c) => c.chain_id === chainId) ?? null, [chains, chainId]);
  // The newer of "the one I just ran" and "the latest recorded run" (which includes the scheduled ones), so a scheduled
  // check that runs after a manual one is not hidden behind it.
  const latest = useMemo(() => {
    if (!chain) return null;
    const manual = verification[chain.chain_id];
    const recorded = chain.last_verification;
    if (!manual || !recorded) return manual ?? recorded;
    return new Date(recorded.finished_at) > new Date(manual.verified_at) ? recorded : manual;
  }, [chain, verification]);

  const verify = async () => {
    if (!chain) return;
    setVerifying(true);
    setVerifyError("");
    try {
      const result = await auditApi.verify({ chain_id: chain.chain_id });
      setVerification((prev) => ({ ...prev, [chain.chain_id]: result }));
      loadSummary();
    } catch (err) {
      setVerifyError(errorMessage(err, tx("Verification could not be completed.")));
    } finally {
      setVerifying(false);
    }
  };

  // A verification can point at an event that is no longer there (SEQUENCE_GAP): then there is no row to filter to or
  // open, so show what the ledger still knows about that sequence number instead.
  const showEvent = async (id: string, sequence: number) => {
    setFilters({ ...EMPTY_FILTERS, chain_id: id, sequence: String(sequence) });
    setDebouncedFilters({ ...EMPTY_FILTERS, chain_id: id, sequence: String(sequence) });
    try {
      const info = await auditApi.sequence(id, sequence);
      if (info.present && info.event_id) setSelectedId(info.event_id);
      else setMissing(info);
    } catch (err) {
      setVerifyError(errorMessage(err, tx("Could not load this event.")));
    }
  };

  // Demo tools changed the ledger: refresh the list and the status panels. Integrity is NOT re-checked here: that happens on
  // the scheduled run (every AUDIT_VERIFY_INTERVAL_SECONDS) or when someone clicks Verify, so the old result stays until then.
  const ledgerChanged = () => {
    loadSummary();
    loadEvents();
  };

  const narrow = (patch: Partial<EventFilters>) => {
    const next = { ...EMPTY_FILTERS, ...patch };
    setFilters(next);
    setDebouncedFilters(next);
    setSelectedId(null);
  };

  if (role === null) return null;

  if (!authorized) {
    return (
      <div className="mx-auto max-w-md p-10 text-center">
        <h1 className="text-lg font-semibold text-slate-900">{tx("Access restricted")}</h1>
        <p className="mt-2 text-sm text-slate-500">{tx("The audit trail is available to the platform administrator only.")}</p>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className="mx-auto w-full max-w-screen-2xl space-y-5 px-4 py-5 font-sans sm:px-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-400">{tx("Administration")} › {tx("Security & Compliance")}</p>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{tx("Audit Trail")}</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {tx("A read-only record of who did what, across the platform. Entries cannot be edited or deleted here.")}
          </p>
        </div>
        {demo && (
          <button type="button" onClick={() => setBinOpen(true)} title={tx("Demo only: deleted events can be restored from here")}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6" />
            </svg>
            {tx("Recycle bin")}
          </button>
        )}
      </header>

      <IntegrityPanel
        chains={chains}
        chain={chain}
        onSelectChain={setChainId}
        tenantLabel={tenantLabel}
        isSuperAdmin={isSuperAdmin}
        latest={latest}
        verifying={verifying}
        verifyError={verifyError}
        onVerify={verify}
        onShowEvent={showEvent}
        ops={ops}
      />

      <CheckpointPanel chainId={chain?.chain_id ?? ""} isSuperAdmin={isSuperAdmin} />

      <ArchivePanel chainId={chain?.chain_id ?? ""} isSuperAdmin={isSuperAdmin} />

      <Filters filters={filters} onChange={setFilters} facets={facets} isSuperAdmin={isSuperAdmin} chains={chains} tenantLabel={tenantLabel} />

      <section aria-label={tx("Audit events")} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {error ? (
          <div role="alert" className="p-6 text-sm text-rose-700">
            {error}
            <button type="button" onClick={loadEvents} className="ms-3 font-semibold underline-offset-2 hover:underline">{tx("Try again")}</button>
          </div>
        ) : loading && events.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-400">{tx("Loading audit events…")}</div>
        ) : events.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm text-slate-600">{tx("No audit events match these filters.")}</p>
            <p className="mt-1 text-xs text-slate-400">{tx("Events appear within a few seconds of the action that caused them.")}</p>
          </div>
        ) : (
          <EventTable events={events} loading={loading} selectedId={selectedId} onSelect={setSelectedId} showTenant={isSuperAdmin} tenantLabel={tenantLabel} />
        )}

        <footer className="flex flex-col gap-2 border-t border-slate-100 bg-slate-50 px-4 py-2.5 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <span className="tabular-nums">{tx("Showing {0}–{1} of {2} events", { 0: from.toLocaleString(), 1: to.toLocaleString(), 2: total.toLocaleString() })}</span>
          <span className="flex items-center gap-3">
            <label className="flex items-center gap-1.5">
              {tx("Rows")}
              <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs">
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border border-slate-300 bg-white px-2.5 py-1 font-semibold text-slate-700 disabled:opacity-40">{tx("Previous")}</button>
            <span className="tabular-nums">{tx("Page {0} of {1}", { 0: page, 1: totalPages })}</span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="rounded border border-slate-300 bg-white px-2.5 py-1 font-semibold text-slate-700 disabled:opacity-40">{tx("Next")}</button>
          </span>
        </footer>
      </section>

      {missing && (
        <MissingEventDrawer
          info={missing}
          tenantLabel={tenantLabel}
          onNarrow={(patch) => { setMissing(null); narrow(patch); }}
          onClose={() => setMissing(null)}
          onOpen={(id) => { setMissing(null); setSelectedId(id); }}
        />
      )}

      {selectedId && (
        <EventDrawer
          eventId={selectedId}
          onClose={() => setSelectedId(null)}
          onOpen={setSelectedId}
          onNarrow={narrow}
          tenantLabel={tenantLabel}
          demo={demo}
          onDeleted={() => { setSelectedId(null); ledgerChanged(); }}
        />
      )}

      {demo && binOpen && (
        <RecycleBinDrawer
          tenantLabel={tenantLabel}
          onClose={() => setBinOpen(false)}
          onRestored={ledgerChanged}
        />
      )}
    </div>
  );
}
