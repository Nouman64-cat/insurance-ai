"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "@/app/services/api";
import { tx } from "@/lib/i18n/tx";
import {
  AuditEvent, ChainSummary, EMPTY_FILTERS, EventFilters, Facets, OpsStatus, VerificationResult,
  auditApi, errorMessage,
} from "@/lib/audit";
import CheckpointPanel from "./CheckpointPanel";
import EventDrawer from "./EventDrawer";
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
  const [tenantNames, setTenantNames] = useState<Record<string, string>>({});
  const requestSeq = useRef(0);

  useEffect(() => { setRole(localStorage.getItem("user_role") ?? ""); }, []);
  const isSuperAdmin = role === "SuperAdmin";
  const authorized = role === "Admin" || role === "SuperAdmin";

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

  useEffect(() => {
    if (!authorized) return;
    loadSummary();
    auditApi.facets().then(setFacets).catch(() => undefined);
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
  const latest = chain ? verification[chain.chain_id] ?? chain.last_verification : null;

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

  const showEvent = (id: string, sequence: number) => {
    setFilters({ ...EMPTY_FILTERS, chain_id: id, sequence: String(sequence) });
    setDebouncedFilters({ ...EMPTY_FILTERS, chain_id: id, sequence: String(sequence) });
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
        <p className="mt-2 text-sm text-slate-500">{tx("The audit trail is available to tenant administrators and the platform administrator.")}</p>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className="mx-auto w-full max-w-screen-2xl space-y-5 px-4 py-5 font-sans sm:px-6">
      <header>
        <p className="text-[11px] uppercase tracking-wide text-slate-400">{tx("Administration")} › {tx("Security & Compliance")}</p>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{tx("Audit Trail")}</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {tx("A read-only record of who did what, across the platform. Entries cannot be edited or deleted here.")}
        </p>
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

      {selectedId && (
        <EventDrawer
          eventId={selectedId}
          onClose={() => setSelectedId(null)}
          onOpen={setSelectedId}
          onNarrow={narrow}
          tenantLabel={tenantLabel}
        />
      )}
    </div>
  );
}
