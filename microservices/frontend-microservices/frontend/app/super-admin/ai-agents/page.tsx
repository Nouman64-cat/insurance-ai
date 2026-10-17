"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import api from "@/app/services/api";
import { tx } from "@/lib/i18n/tx";

type Tab = "agents" | "subagents" | "tools" | "skills";
interface Config {
  skill_agent_enabled: boolean;
  propagation_seconds: number;
  updated_at: string | null;
}
interface Agent {
  id: string; name: string; node: string; description?: string;
  tools: string[]; subagents?: string[]; roles?: string[]; enabled?: boolean;
}
interface Tool {
  id: string; name: string; description: string; domain: string;
  mutating: boolean; available: boolean; execution: string; roles: string[];
  subagents: string[]; skills: string[]; schema: Record<string, unknown>;
}
interface Skill {
  id: string; name: string; purpose: string; intents: string[]; roles: string[];
  tools: string[]; prerequisites: string[]; business_rules: string[];
  approvals: string; verification: string; unsupported: string[];
  steps: { id: string; capability: string; depends_on: string[] }[];
}
interface Inventory {
  skill_agent_enabled: boolean; roles: string[]; agents: Agent[];
  subagents: Agent[]; tools: Tool[]; skills: Skill[]; journeys: string[];
  limits: { max_bound_tools: number; max_loaded_capabilities: number; max_selected_skills: number };
  note: string;
}
const tabs: { id: Tab; label: string }[] = [
  { id: "agents", label: "Agents" }, { id: "subagents", label: "Subagents" },
  { id: "tools", label: "Tools" }, { id: "skills", label: "Skills" },
];
const fieldClass = "rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

function Tags({ items }: { items: string[] }) {
  return <div className="flex flex-wrap gap-1.5">{items.map(item => <span key={item} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">{tx(item)}</span>)}</div>;
}

export default function AIAgentsPage() {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [draft, setDraft] = useState(true);
  const [tab, setTab] = useState<Tab>("agents");
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const loadInventory = useCallback(async () => {
    const result = await api.get<Inventory>("/chat/platform-inventory");
    setInventory(result.data);
  }, []);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    // Settings remain usable when the registry service is temporarily unavailable.
    const results = await Promise.allSettled([
      api.get<Config>("/platform/agent-config").then(result => { setConfig(result.data); setDraft(result.data.skill_agent_enabled); }),
      loadInventory(),
    ]);
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") setError(failure.reason?.message || tx("Failed to load AI agent settings."));
    setLoading(false);
  }, [loadInventory]);

  useEffect(() => {
    const allowed = localStorage.getItem("user_role") === "SuperAdmin";
    setAuthorized(allowed);
    if (allowed) void load(); else setLoading(false);
  }, [load]);
  useEffect(() => { setPage(0); }, [tab, query, role]);
  useEffect(() => {
    if (!config || !inventory || config.skill_agent_enabled === inventory.skill_agent_enabled) return;
    const timer = setTimeout(() => { void loadInventory().catch(err => setError(err.message)); }, (config.propagation_seconds + 1) * 1000);
    return () => clearTimeout(timer);
  }, [config, inventory, loadInventory]);

  const save = async () => {
    setSaving(true); setError(""); setSuccess("");
    try {
      const result = await api.put<Config>("/platform/agent-config", { skill_agent_enabled: draft });
      setConfig(result.data); setDraft(result.data.skill_agent_enabled);
      setSuccess(tx("AI agent settings saved. New chat requests pick up changes within a few seconds."));
      void loadInventory().catch(err => setError(err.message));
    } catch (err) { setError(err instanceof Error ? err.message : tx("Failed to save AI agent settings.")); }
    finally { setSaving(false); }
  };

  const entries = useMemo(() => {
    if (!inventory) return [];
    const text = query.toLowerCase().trim();
    return inventory[tab].filter((item: Agent | Tool | Skill) => {
      if (role && !(item.roles || inventory.roles).includes(role)) return false;
      const description = "purpose" in item ? item.purpose : "description" in item ? item.description : "";
      return !text || [item.id, item.name, description, ...(item.roles || []), ...("tools" in item ? item.tools : []), ...("skills" in item ? item.skills : [])].join(" ").toLowerCase().includes(text);
    });
  }, [inventory, tab, query, role]);
  const pageSize = 20;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(entries.length / pageSize) - 1));
  const visible = entries.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  if (authorized === false) return <div className="p-8"><h1 className="text-xl font-semibold">{tx("Access Denied")}</h1><p className="mt-2 text-slate-500">{tx("This page is restricted to platform SuperAdmins.")}</p></div>;
  return <div className="mx-auto w-full max-w-screen-2xl space-y-6 px-6 py-6 font-sans">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs font-semibold uppercase tracking-widest text-blue-600">{tx("Platform")}</p><h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{tx("AI Agents")}</h1><p className="mt-2 text-sm text-slate-500">{tx("Control skill-driven orchestration and explore the live agent registry.")}</p></div>
      <button onClick={() => void load()} disabled={loading || saving} className={`${fieldClass} disabled:opacity-50`}>{loading ? tx("Loading…") : tx("Refresh")}</button>
    </header>
    {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
    {success && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">{success}</div>}
    <section aria-labelledby="skill-setting" className="flex flex-wrap items-center justify-between gap-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="max-w-2xl"><div className="flex items-center gap-3"><h2 id="skill-setting" className="font-semibold text-slate-900">{tx("Skill-driven agent")}</h2><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${config?.skill_agent_enabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{config ? (config.skill_agent_enabled ? tx("Enabled") : tx("Disabled")) : tx("Loading…")}</span></div>
        <p className="mt-2 text-sm leading-6 text-slate-500">{tx("Enable dynamic skill selection and on-demand tool discovery for chat. Changes apply to new requests within 5 seconds; permissions and approval requirements stay enforced.")}</p>
        {config?.updated_at && <p className="mt-2 text-xs text-slate-400">{tx("Last updated")}: {new Date(config.updated_at.endsWith("Z") ? config.updated_at : config.updated_at + "Z").toLocaleString()}</p>}
      </div>
      <div className="flex items-center gap-4"><button type="button" role="switch" aria-checked={draft} aria-label={tx("Skill-driven agent")} disabled={!config || saving} onClick={() => { setDraft(!draft); setSuccess(""); }} className={`relative h-7 w-12 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-40 ${draft ? "bg-blue-600" : "bg-slate-300"}`}><span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${draft ? "left-1 translate-x-5" : "left-1 translate-x-0"}`} /></button><button onClick={() => void save()} disabled={!config || saving || draft === config.skill_agent_enabled} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40">{saving ? tx("Saving…") : tx("Save changes")}</button></div>
    </section>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{tabs.map(item => <button key={item.id} aria-pressed={tab === item.id} onClick={() => setTab(item.id)} className={`rounded-xl border p-4 text-left transition-colors ${tab === item.id ? "border-blue-300 bg-blue-50" : "border-slate-200 bg-white hover:border-slate-300"}`}><span className="text-xs font-medium text-slate-500">{tx(item.label)}</span><span className="mt-1 block text-2xl font-semibold text-slate-900">{inventory ? inventory[item.id].length : "—"}</span></button>)}</div>
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4"><h2 className="font-semibold text-slate-900">{tx(tabs.find(item => item.id === tab)!.label)}</h2><div className="flex flex-wrap gap-2"><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={tx("Search names, roles or capabilities…")} aria-label={tx("Search registry")} className={`${fieldClass} w-72 max-w-full`} /><select value={role} onChange={e => setRole(e.target.value)} aria-label={tx("Filter by role")} className={fieldClass}><option value="">{tx("All roles")}</option>{inventory?.roles.map(name => <option key={name} value={name}>{tx(name)}</option>)}</select></div></div>
      {!inventory ? <p className="p-8 text-sm text-slate-500">{loading ? tx("Loading registry…") : tx("Registry unavailable. Refresh to try again.")}</p> : !entries.length ? <p className="p-8 text-sm text-slate-500">{tx("No matching registry entries.")}</p> : <div className="divide-y divide-slate-100">{visible.map(item => <details key={item.id} className="group p-5">
        <summary className="cursor-pointer list-none"><div className="flex flex-wrap items-center justify-between gap-3"><div><div className="flex items-center gap-2"><h3 className="font-medium text-slate-900">{tx(item.name)}</h3>{"mutating" in item && <span className={`rounded-full px-2 py-0.5 text-xs ${item.mutating ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-500"}`}>{item.mutating ? tx("Action") : tx("Read")}</span>}{"available" in item && !item.available && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{tx("Unavailable")}</span>}{"enabled" in item && <span className={`rounded-full px-2 py-0.5 text-xs ${item.enabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{item.enabled ? tx("Enabled") : tx("Disabled")}</span>}</div><p className="mt-1 text-xs text-slate-400">{item.id}</p></div><span className="text-xs text-slate-400 group-open:rotate-180" aria-hidden="true">⌄</span></div>{("purpose" in item || "description" in item) && <p className="mt-2 line-clamp-2 max-w-5xl text-sm leading-6 text-slate-500">{tx(("purpose" in item ? item.purpose : item.description) || "")}</p>}</summary>
        <div className="mt-4 space-y-4 border-t border-slate-100 pt-4 text-sm">
          {item.roles && <div><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{tx("Roles")}</p><Tags items={item.roles} /></div>}
          {"node" in item && <p className="text-slate-500">{tx("Workflow node")}: <code className="text-xs">{item.node}</code></p>}
          {"tools" in item && item.tools.length > 0 && <div><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{tx("Tools")} · {item.tools.length}</p><Tags items={item.tools} /></div>}
          {"subagents" in item && item.subagents && item.subagents.length > 0 && <div><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{tx("Subagents")}</p><Tags items={item.subagents} /></div>}
          {"skills" in item && <div><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{tx("Skills")}</p><Tags items={item.skills} /></div>}
          {"prerequisites" in item && <><div><p className="mb-2 font-medium text-slate-700">{tx("Prerequisites")}</p><ul className="list-inside list-disc space-y-1 text-slate-500">{item.prerequisites.map(text => <li key={text}>{tx(text)}</li>)}</ul></div><div><p className="mb-2 font-medium text-slate-700">{tx("Business rules")}</p><ul className="list-inside list-disc space-y-1 text-slate-500">{item.business_rules.map(text => <li key={text}>{tx(text)}</li>)}</ul></div><p className="text-slate-500">{tx(item.verification)}</p>{item.unsupported.length > 0 && <div className="rounded-lg bg-amber-50 p-3 text-amber-800"><p className="mb-1 font-medium">{tx("Manual handoff")}</p>{item.unsupported.map(text => <p key={text}>{tx(text)}</p>)}</div>}</>}
          {"schema" in item && <details><summary className="cursor-pointer text-blue-600">{tx("Parameter schema")}</summary><pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-slate-950 p-4 text-xs text-slate-100">{JSON.stringify(item.schema, null, 2)}</pre></details>}
        </div>
      </details>)}</div>}
      {entries.length > 0 && <div className="flex items-center justify-between border-t border-slate-100 p-4 text-xs text-slate-500"><span>{currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, entries.length)} / {entries.length}</span><div className="flex gap-2"><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="rounded border border-slate-200 px-3 py-1.5 disabled:opacity-30">{tx("Previous")}</button><button disabled={(currentPage + 1) * pageSize >= entries.length} onClick={() => setPage(currentPage + 1)} className="rounded border border-slate-200 px-3 py-1.5 disabled:opacity-30">{tx("Next")}</button></div></div>}
    </section>
    {inventory && <p className="text-xs leading-5 text-slate-400">{tx("The registry reflects deployed code. Tool access remains subject to current permissions, tenant boundaries and backend checks.")} {tx("Registered tools are not a claim of live-service validation.")}</p>}
  </div>;
}
