"use client";

import { useEffect, useRef } from "react";
import api from "@/app/services/api";
import { errMsg, mpBase, pkr } from "./groupShared";

interface Props {
  /** The pending graph interrupt, if any (kind "client_execute" for browser-side tools). */
  interrupt: { kind?: string; toolCall?: { name: string; args: any } } | null | undefined;
  /** Hand the tool's result back to the graph so it resumes. */
  resolve: (result: any) => void;
  notify?: (message: string, ok: boolean) => void;
}

const TOOL = "upload_group_census";

/**
 * Browser half of the agent's `upload_group_census` tool. The browser holds the
 * file, so when the graph reaches the tool it opens the file picker; the chosen
 * CSV/XLSX is read, validated and (unless confirm is false) enrolled through the
 * same endpoints the Members tab uses, and the outcome goes back to the agent.
 */
export default function GroupCensusClientTool({ interrupt, resolve, notify }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const args = useRef<any>(null);
  const waiting = useRef(false);

  const finish = (result: any) => {
    waiting.current = false;
    args.current = null;
    if (input.current) input.current.value = "";
    resolve(result);
  };

  useEffect(() => {
    if (interrupt?.kind !== "client_execute" || interrupt.toolCall?.name !== TOOL) {
      waiting.current = false;
      return;
    }
    if (waiting.current) return;
    waiting.current = true;
    args.current = interrupt.toolCall.args;
    notify?.("📎 Choose the census file (.csv or .xlsx) — I'll check every row and enrol it.", true);
    input.current?.click();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interrupt]);

  // Closing the picker without a file would leave the chat waiting forever.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const onCancel = () => { if (waiting.current) finish({ success: false, error: "No file was chosen, so nothing was uploaded." }); };
    el.addEventListener("cancel", onCancel);
    return () => el.removeEventListener("cancel", onCancel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handle = async (file: File) => {
    const a = args.current;
    if (!a) return;
    const tenantId = localStorage.getItem("tenant_id") ?? "";
    const base = mpBase(tenantId, a.organization_id, a.master_policy_id);
    const name = a.organization_name as string;
    const orgRoute = `admin/organizations/${a.organization_id}`;
    try {
      const form = new FormData();
      form.append("file", file);
      const parsed = (await api.post(`${base}/census/parse`, form, { headers: { "Content-Type": "multipart/form-data" } })).data;
      const verdict = (await api.post(`${base}/census/validate`, { employees: parsed.rows })).data;
      if (!verdict.is_valid) {
        const problems = [...(verdict.missing_fields ?? []), ...(verdict.errors ?? [])];
        finish({
          success: false, census_invalid: true,
          error: `${file.name}: the census has problems and nothing was enrolled — ${problems.slice(0, 8).join("; ")}${problems.length > 8 ? `; …and ${problems.length - 8} more` : ""}`,
          quick_actions: [{ label: "Upload corrected census", actionType: "submit", payload: `Upload the employee census for ${name}` }],
        });
        return;
      }
      if (a.confirm === false) {
        finish({ success: true, validated: true, rows: parsed.row_count, message: `${file.name}: all ${parsed.row_count} rows are valid (not enrolled yet).` });
        return;
      }
      const done = (await api.post(`${base}/census/confirm`, { employees: parsed.rows })).data;
      const above = done.employees.filter((e: any) => e.coverage_amount > done.free_cover_limit).length;
      finish({
        success: true, enrolled: done.employees.length, free_cover_limit: done.free_cover_limit, above_fcl: above,
        message: `Enrolled ${done.employees.length} employees from ${file.name}. Free Cover Limit ${pkr(done.free_cover_limit)}` +
          (above ? `; ${above} above it need an underwriting decision before a quote.` : "; all guaranteed-issue.") +
          (parsed.ignored_columns?.length ? ` Ignored columns: ${parsed.ignored_columns.join(", ")}.` : ""),
        last_action: { tool_name: TOOL, entity_type: "organization", entity_id: a.organization_id, route: `${orgRoute}?tab=members`, label: `${done.employees.length} employees enrolled for ${name}` },
        quick_actions: [
          { label: "Continue group scheme", actionType: "submit", payload: `Continue the group journey for ${name}` },
          { label: "Open members", actionType: "navigate", payload: `${orgRoute}?tab=members` },
        ],
      });
    } catch (e: any) {
      finish({ success: false, error: errMsg(e, "Could not read or enrol that file.") });
    }
  };

  return (
    <input
      ref={input}
      type="file"
      accept=".csv,.xlsx"
      className="hidden"
      onChange={(e) => { const f = e.target.files?.[0]; if (f) handle(f); }}
    />
  );
}
