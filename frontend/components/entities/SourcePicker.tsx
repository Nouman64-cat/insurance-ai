"use client";

import { useEffect, useState } from "react";
import api from "@/app/services/api";
import { AcquisitionSource, SOURCE_TYPE_LABELS, SOURCE_TYPE_ORDER } from "./customerShared";

/** The tenant's acquisition sources (agents, brokers, bank desks...), loaded whenever a form opens. */
export function useAcquisitionSources(open: boolean): AcquisitionSource[] {
  const [sources, setSources] = useState<AcquisitionSource[]>([]);
  useEffect(() => {
    if (!open) return;
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    api
      .get<AcquisitionSource[]>(`/tenants/${tenantId}/acquisition-sources`)
      .then((resp) => setSources((resp.data || []).filter((s) => s.is_active !== false)))
      .catch(() => setSources([]));
  }, [open]);
  return sources;
}

interface Props {
  sources: AcquisitionSource[];
  /** The chosen source's id, or "" for none. */
  sourceId: string;
  /** Called with the chosen source (null when cleared), so the form can also assign its linked agent. */
  onChange: (source: AcquisitionSource | null) => void;
  labelClass: string;
  selectClass: string;
  /** Wrap each field (the forms lay their fields out differently). */
  fieldClass?: string;
}

/**
 * Two steps, the way the lead is actually generated: first the KIND of source (Agent, Broker,
 * Bancassurance...), then the specific one of that kind. Choosing "Agent" lists every agent source, and
 * so on. Shared by the quick and complete forms for individuals, families and corporates.
 */
export default function SourcePicker({ sources, sourceId, onChange, labelClass, selectClass, fieldClass = "" }: Props) {
  const selected = sources.find((s) => s.id === sourceId) ?? null;
  const [type, setType] = useState("");

  // A source chosen elsewhere (a default, or the record being edited) decides the kind shown.
  useEffect(() => {
    if (selected) setType(selected.source_type);
    else if (!sourceId) setType((t) => t);
  }, [selected?.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!sourceId && sources.length === 0) setType(""); }, [sources.length]);   // eslint-disable-line react-hooks/exhaustive-deps

  const ofType = sources.filter((s) => s.source_type === type);
  const kinds = SOURCE_TYPE_ORDER.filter((t) => sources.some((s) => s.source_type === t) || t === type);

  return (
    <>
      <div className={fieldClass}>
        <label className={labelClass}>Lead source type</label>
        <select
          value={type}
          onChange={(e) => { setType(e.target.value); if (selected && selected.source_type !== e.target.value) onChange(null); }}
          className={selectClass}
        >
          <option value="">-- Direct / Unassigned --</option>
          {kinds.map((t) => (
            <option key={t} value={t}>{SOURCE_TYPE_LABELS[t] ?? t}</option>
          ))}
        </select>
      </div>

      {type && (
        <div className={fieldClass}>
          <label className={labelClass}>{SOURCE_TYPE_LABELS[type] ?? type}</label>
          <select
            value={sourceId}
            onChange={(e) => onChange(sources.find((s) => s.id === e.target.value) ?? null)}
            className={selectClass}
          >
            <option value="">{ofType.length ? `-- Choose ${(SOURCE_TYPE_LABELS[type] ?? type).toLowerCase()} --` : `-- No ${(SOURCE_TYPE_LABELS[type] ?? type).toLowerCase()} sources yet --`}</option>
            {ofType.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.partner_name ? ` — ${s.partner_name}` : ""} ({s.code})
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
}
