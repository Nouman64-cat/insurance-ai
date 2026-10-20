"use client";

import { tx } from "@/lib/i18n/tx";
import { ChainSummary, EMPTY_FILTERS, EventFilters, Facets, activeFilterCount, titleCase } from "@/lib/audit";

const field = "w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-400";

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{tx(text)}</span>
      {children}
    </label>
  );
}

interface Props {
  filters: EventFilters;
  onChange: (next: EventFilters) => void;
  facets: Facets | null;
  isSuperAdmin: boolean;
  chains: ChainSummary[];
  tenantLabel: (tenantId: string | null) => string;
}

export default function Filters({ filters, onChange, facets, isSuperAdmin, chains, tenantLabel }: Props) {
  const set = (patch: Partial<EventFilters>) => onChange({ ...filters, ...patch });
  const active = activeFilterCount(filters);
  const select = (key: keyof EventFilters, values: string[] | undefined, format: (v: string) => string = titleCase) => (
    <select value={filters[key]} onChange={(e) => set({ [key]: e.target.value } as Partial<EventFilters>)} className={field}>
      <option value="">{tx("All")}</option>
      {(values ?? []).map((v) => <option key={v} value={v}>{format(v)}</option>)}
    </select>
  );

  return (
    <form
      role="search"
      aria-label={tx("Filter audit events")}
      onSubmit={(e) => e.preventDefault()}
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2">
          <Label text="Search">
            <input
              type="search"
              value={filters.q}
              onChange={(e) => set({ q: e.target.value })}
              placeholder={tx("Action, entity, actor, case or correlation id")}
              className={field}
            />
          </Label>
        </div>
        <Label text="Module">{select("module", facets?.modules)}</Label>
        <Label text="Outcome">{select("outcome", ["SUCCESS", "FAILURE", "DENIED"], titleCase)}</Label>
        <Label text="Action">{select("action", facets?.actions, (v) => v)}</Label>
        <Label text="Entity">{select("entity_type", facets?.entity_types)}</Label>
        <Label text="Actor">
          <input value={filters.actor} onChange={(e) => set({ actor: e.target.value })} placeholder={tx("Name or user id")} className={field} />
        </Label>
        {isSuperAdmin ? (
          <Label text="Tenant">
            <select value={filters.tenant} onChange={(e) => set({ tenant: e.target.value })} className={field}>
              <option value="">{tx("All tenants")}</option>
              <option value="platform">{tx("Platform (system events)")}</option>
              {chains.filter((c) => c.scope === "TENANT").map((c) => (
                <option key={c.chain_id} value={c.tenant_id ?? ""}>{tenantLabel(c.tenant_id)}</option>
              ))}
            </select>
          </Label>
        ) : <div className="hidden lg:block" />}
        <Label text="From">
          <input type="date" value={filters.dateFrom} max={filters.dateTo || undefined} onChange={(e) => set({ dateFrom: e.target.value })} className={field} />
        </Label>
        <Label text="To">
          <input type="date" value={filters.dateTo} min={filters.dateFrom || undefined} onChange={(e) => set({ dateTo: e.target.value })} className={field} />
        </Label>
      </div>

      {(filters.entity_id || filters.case_id || filters.correlation_id || filters.chain_id) && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-slate-500">{tx("Narrowed to")}</span>
          {([["entity_id", "Entity"], ["case_id", "Case"], ["correlation_id", "Request"], ["chain_id", "Chain"]] as const).map(([key, label]) =>
            filters[key] ? (
              <button
                key={key}
                type="button"
                onClick={() => set({ [key]: "", ...(key === "chain_id" ? { sequence: "" } : {}) } as Partial<EventFilters>)}
                className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 text-slate-700 hover:bg-slate-100"
                title={filters[key]}
              >
                {tx(label)}: <span className="max-w-[10rem] truncate font-mono">{filters[key]}</span>
                {key === "chain_id" && filters.sequence ? ` #${filters.sequence}` : ""}
                <span aria-hidden="true">×</span>
                <span className="sr-only">{tx("Remove filter")}</span>
              </button>
            ) : null)}
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-[11px] text-slate-400">{active ? tx("{0} filter(s) applied", { 0: active }) : tx("Showing everything you are allowed to see")}</p>
        <button
          type="button"
          disabled={!active}
          onClick={() => onChange(EMPTY_FILTERS)}
          className="rounded-md border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {tx("Clear filters")}
        </button>
      </div>
    </form>
  );
}
