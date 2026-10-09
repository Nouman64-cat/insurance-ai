"use client";

// "Add New Family" with complete details, in one window and three tabs:
//   1. Family details   2. Policy (floater / life bundle)   3. Members
// Mirrors the individual customer's full-entry form, including "Upload document":
// a PDF / PNG / JPG describing the household fills all three tabs. Nothing is written
// until the last tab's "Create family & enrol" — then the family, its policy and its
// members are created in that order (a retry after a failure continues where it stopped).

import { useEffect, useMemo, useRef, useState } from "react";
import api, { OCR_BASE_URL } from "@/app/services/api";
import { listBranches, Branch } from "@/app/services/branches";
import { listAgents, Agent } from "@/app/services/agents";
import SourcePicker, { useAcquisitionSources } from "./SourcePicker";
import { listInsurancePlans, InsurancePlan } from "@/app/services/insurancePlans";
import { PAKISTAN_PROVINCES } from "@/lib/pakistanProvinces";
import { notifyParentPortal } from "@/lib/agent/portalMessage";
import FamilyMembersEditor, { FamilyRow, NOMINEE_RELATIONSHIPS, blankRow, buildMembersPayload, checkRows, formatCNIC, isInsured, startRows } from "@/components/family/FamilyMembersEditor";

interface Props {
  open: boolean;
  onClose: () => void;
  /** `isNew` is true when the family still needs members / a policy (so callers can open its Manage page). */
  onSaved: (message: string, entity: { id: string; isNew: boolean }) => void;
}

type Tab = "family" | "policy" | "members";
type PolicyKind = "Floater" | "LifeBundle";

const todayIso = () => new Date().toISOString().slice(0, 10);

const INPUT = "w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all";

export default function FamilyFullEntryModal({ open, onClose, onSaved }: Props) {
  const [tab, setTab] = useState<Tab>("family");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);

  // Tab 1
  const [name, setName] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [householdIncome, setHouseholdIncome] = useState("");
  const [city, setCity] = useState("");
  const [province, setProvince] = useState("");
  const [branchId, setBranchId] = useState("");
  const [assignedAgentId, setAssignedAgentId] = useState("");
  const [branchOptions, setBranchOptions] = useState<Branch[]>([]);
  const [agentOptions, setAgentOptions] = useState<Agent[]>([]);
  const [acquisitionSourceId, setAcquisitionSourceId] = useState("");
  const sources = useAcquisitionSources(open);

  // Tab 2
  const [kind, setKind] = useState<PolicyKind>("Floater");
  const [sumInsured, setSumInsured] = useState("5000000");
  const [term, setTerm] = useState("1");
  const [effective, setEffective] = useState(todayIso());
  const [discount, setDiscount] = useState("10");
  const [lifePlans, setLifePlans] = useState<InsurancePlan[]>([]);

  // Tab 3
  const [rows, setRows] = useState<FamilyRow[]>(startRows());

  // Upload
  const fileRef = useRef<HTMLInputElement>(null);
  const [extracting, setExtracting] = useState(false);
  const [progress, setProgress] = useState(0);
  // Keys the document did not contain — highlighted while still empty.
  const [flagged, setFlagged] = useState<Set<string>>(new Set());

  // Created so far, so a retry after a failed step doesn't duplicate the family or its policy.
  const created = useRef<{ familyId?: string; policyId?: string }>({});

  const isBundle = kind === "LifeBundle";

  useEffect(() => {
    if (!open) return;
    setTab("family"); setError(""); setNotice(null); setFlagged(new Set());
    setName(""); setContactPerson(""); setContactEmail(""); setContactPhone(""); setHouseholdIncome("");
    setCity(""); setProvince(""); setBranchId(""); setAssignedAgentId(""); setAcquisitionSourceId("");
    setKind("Floater"); setSumInsured("5000000"); setTerm("1"); setEffective(todayIso()); setDiscount("10");
    setRows(startRows());
    created.current = {};
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    listAgents(tenantId).then(setAgentOptions).catch(() => setAgentOptions([]));
    listBranches(tenantId).then(setBranchOptions).catch(() => setBranchOptions([]));
    listInsurancePlans(tenantId)
      .then((plans) => setLifePlans(plans.filter((p) => (p.insurance_type === "TERM_LIFE" || p.insurance_type === "WHOLE_LIFE") && p.is_active)))
      .catch(() => setLifePlans([]));
  }, [open]);

  const empty = (v: unknown) => v === undefined || v === null || String(v).trim() === "";

  // Which fields still need attention, by tab — drives the amber dots and highlights.
  const isMissing = (key: string, value: unknown) => flagged.has(key) && empty(value);
  const hi = (key: string, value: unknown) => (isMissing(key, value) ? "!border-amber-400 !bg-amber-50" : "");
  const tabHasMissing = useMemo(() => ({
    family: [["name", name], ["contact_person", contactPerson], ["household_income", householdIncome], ["city", city], ["province", province]]
      .some(([k, v]) => isMissing(k as string, v)),
    policy: (kind === "Floater" ? [["sum_insured", sumInsured]] : [["discount", discount]]).concat([["term", term], ["effective", effective]])
      .some(([k, v]) => isMissing(k as string, v)),
    members: rows.some((r, i) => (Object.keys(r) as (keyof FamilyRow)[]).some((f) => flagged.has(`member.${i}.${f}`) && empty(String(r[f] ?? "")))) || flagged.has("members"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [flagged, name, contactPerson, householdIncome, city, province, kind, sumInsured, discount, term, effective, rows]);

  // ── Upload & read a document ───────────────────────────────────────────────
  const handleUpload = async (file: File) => {
    const ext = file.name.toLowerCase().split(".").pop() || "";
    if (!["pdf", "png", "jpg", "jpeg"].includes(ext)) { setNotice({ tone: "error", text: "Unsupported file. Please upload a PDF, PNG or JPG." }); return; }
    if (file.size > 10 * 1024 * 1024) { setNotice({ tone: "error", text: "That file is larger than 10 MB." }); return; }
    setExtracting(true); setProgress(0); setNotice(null);
    let creep: ReturnType<typeof setInterval> | undefined;
    try {
      const body = new FormData();
      body.append("file", file);
      const { ok, status, data } = await new Promise<{ ok: boolean; status: number; data: any }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${OCR_BASE_URL}/extract-family`);
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 50)); };
        xhr.upload.onload = () => { setProgress((p) => Math.max(p, 50)); creep = setInterval(() => setProgress((p) => (p < 95 ? p + 1 : p)), 400); };
        xhr.onload = () => {
          let parsed: any = {};
          try { parsed = JSON.parse(xhr.responseText); } catch { /* non-JSON error body */ }
          resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data: parsed });
        };
        xhr.onerror = () => reject(new Error("Could not reach the document reader."));
        xhr.send(body);
      });
      setProgress(100);
      if (!ok) throw new Error(data.detail || `Extraction failed (${status}).`);

      const f = data.family || {};
      const missing = new Set<string>();
      const take = (key: string, value: unknown, apply: (v: any) => void) => {
        if (empty(value)) { missing.add(key); return; }
        apply(value);
      };
      take("name", f.family_name, setName);
      take("contact_person", f.contact_person, setContactPerson);
      take("contact_email", f.contact_email, setContactEmail);
      take("contact_phone", f.contact_phone, setContactPhone);
      take("household_income", f.household_declared_income, (v) => setHouseholdIncome(String(v)));
      take("city", f.city, setCity);
      take("province", f.province, (v) => (PAKISTAN_PROVINCES as readonly string[]).includes(v) ? setProvince(v) : missing.add("province"));

      const bundle = f.policy_type === "LifeBundle";
      if (f.policy_type) setKind(bundle ? "LifeBundle" : "Floater"); else missing.add("policy_type");
      take("term", f.term_years, (v) => setTerm(String(v)));
      take("effective", f.effective_date, setEffective);
      if (bundle) take("discount", f.discount_percentage, (v) => setDiscount(String(v)));
      else take("sum_insured", f.total_sum_insured, (v) => setSumInsured(String(v)));

      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const read: any[] = Array.isArray(data.members) ? data.members : [];
      if (read.length > 0) {
        const next: FamilyRow[] = read.map((m, i) => {
          // The head is "Self"; a spouse is asked "fully insured?"; every other relative is a nominee.
          const kind = m.relationship === "Self" ? "Self" : m.relationship === "Spouse" ? "Spouse" : "Nominee";
          const row: FamilyRow = blankRow(kind);
          if (kind === "Nominee") row.relationship = NOMINEE_RELATIONSHIPS.includes(m.relationship) ? m.relationship : "Other";
          if (kind === "Spouse") { if (m.is_insured === null || m.is_insured === undefined) missing.add(`member.${i}.insured`); else row.insured = m.is_insured ? "yes" : "no"; }
          const insured = isInsured(row);
          const need: (keyof FamilyRow)[] = ["name", ...(insured ? (["cnic", "dob", "gender", "occupation", "declared_income"] as (keyof FamilyRow)[]) : [])];
          (["name", "cnic", "dob", "gender", "occupation", "declared_income"] as (keyof FamilyRow)[]).forEach((k) => {
            if (!empty(m[k])) (row[k] as string) = k === "cnic" ? formatCNIC(String(m[k])) : String(m[k]);
            else if (need.includes(k)) missing.add(`member.${i}.${k}`);
          });
          if (kind !== "Self") { if (empty(m.share_pct)) missing.add(`member.${i}.share_pct`); else row.share_pct = String(m.share_pct); }
          if (insured) {
            if (m.is_smoker !== null && m.is_smoker !== undefined) row.is_smoker = String(Boolean(m.is_smoker));
            if (!empty(m.height_cm)) row.height_cm = String(m.height_cm);
            if (!empty(m.weight_kg)) row.weight_kg = String(m.weight_kg);
            if (bundle) {
              if (empty(m.coverage_amount)) missing.add(`member.${i}.coverage_amount`); else row.coverage_amount = String(m.coverage_amount);
              const plan = m.plan_name ? lifePlans.find((p) => norm(p.label).includes(norm(m.plan_name)) || norm(m.plan_name).includes(norm(p.label)) || norm(p.code) === norm(m.plan_name)) : undefined;
              if (plan) row.plan_code = plan.code; else missing.add(`member.${i}.plan_code`);
            }
          }
          return row;
        });
        setRows(next);
      } else {
        missing.add("members");
      }
      setFlagged(missing);
      const filled = Number(data.found) || 0;
      const members = read.length;
      setNotice(
        filled === 0
          ? { tone: "warn", text: "No family details could be read from this document. Please fill the tabs manually." }
          : missing.size === 0
          ? { tone: "ok", text: `Filled ${filled} fields (${members} member${members === 1 ? "" : "s"}) from ${file.name}. Please review them before saving.` }
          : { tone: "warn", text: `Filled ${filled} fields (${members} member${members === 1 ? "" : "s"}) from ${file.name}. ${missing.size} value${missing.size === 1 ? "" : "s"} not found in the document ${missing.size === 1 ? "is" : "are"} highlighted — please fill ${missing.size === 1 ? "it" : "them"} in.` },
      );
    } catch (err: any) {
      setNotice({ tone: "error", text: err?.message || "Could not extract details from this document." });
    } finally {
      if (creep) clearInterval(creep);
      setExtracting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // ── Save ───────────────────────────────────────────────────────────────────
  const readError = (err: any, fallback: string): string => {
    let d = err?.response?.data?.detail ?? err?.message ?? fallback;
    if (typeof d === "string") { try { d = JSON.parse(d); } catch { /* plain text */ } }
    if (d && typeof d === "object" && !Array.isArray(d)) {
      const parts = [...(d.missing_fields ?? []), ...(d.errors ?? [])];
      if (parts.length) return parts.join("; ");
      return d.message ? String(d.message) : JSON.stringify(d);
    }
    return Array.isArray(d) ? d.map((x) => (typeof x === "string" ? x : x?.msg ?? JSON.stringify(x))).join("; ") : String(d);
  };

  const submit = async () => {
    setError("");
    if (!name.trim()) { setTab("family"); setError("Family name is required."); return; }
    if (!(parseInt(term) > 0) || !effective) { setTab("policy"); setError("The policy needs a term and an effective date."); return; }
    if (rows.length < 2) { setTab("members"); setError("A family needs at least 2 members."); return; }
    // Check the rows before anything is created, so a typo doesn't leave a family and policy with no members.
    const { problems, flagged: bad } = checkRows(rows, isBundle);
    if (problems.length) {
      setFlagged((prev) => new Set([...Array.from(prev), ...bad]));
      setTab("members"); setError(problems.slice(0, 4).join("; ") + (problems.length > 4 ? `; …and ${problems.length - 4} more` : "")); return;
    }
    setSaving(true);
    const tenantId = localStorage.getItem("tenant_id");
    try {
      if (!created.current.familyId) {
        const resp = await api.post(`/tenants/${tenantId}/families`, {
          name: name.trim(), contact_person: contactPerson || null, contact_email: contactEmail || null, contact_phone: contactPhone || null,
          household_declared_income: householdIncome ? parseFloat(householdIncome) : null,
          city: city || null, province: province || null, branch_id: branchId || null, assigned_agent_id: assignedAgentId || null, acquisition_source_id: acquisitionSourceId || null,
        });
        created.current.familyId = resp.data.id;
      }
      const familyId = created.current.familyId!;

      if (!created.current.policyId) {
        const resp = isBundle
          ? await api.post(`/tenants/${tenantId}/families/${familyId}/life-bundle-policies`, { term_years: parseInt(term), effective_date: effective, discount_percentage: parseFloat(discount) || 0 })
          : await api.post(`/tenants/${tenantId}/families/${familyId}/floater-policies`, { total_sum_insured: parseFloat(sumInsured) || 0, term_years: parseInt(term), effective_date: effective });
        created.current.policyId = resp.data.id;
      }
      const policyId = created.current.policyId!;

      const sent = buildMembersPayload(rows, isBundle);
      const insuredSent = sent.filter((m: any) => m.is_insured);
      const path = isBundle ? "life-bundle-policies" : "floater-policies";
      let outcomes: any[];
      try {
        outcomes = (await api.post(`/tenants/${tenantId}/families/${familyId}/${path}/${policyId}/members/confirm`, { members: sent })).data.members;
      } catch (err: any) {
        // The family and policy now exist; say so, so the user knows only the members need fixing.
        setTab("members");
        setError(`The family and its policy were created, but the members were not enrolled: ${readError(err, "Failed to enrol the members.")} Fix the rows and press the button again.`);
        return;
      }

      // Embedded in the Copilot: close the window and carry on with the proposal steps in the chat.
      notifyParentPortal("family_members_enrolled", {
        family_group_id: familyId, family_policy_id: policyId, name: name.trim(), is_life_bundle: isBundle,
        // Only the head and an insured spouse have underwriting cases, head first; they come back in the order sent.
        cases: outcomes.map((o: any, i: number) => ({ case_id: o.case_id, case_number: o.case_number, name: (insuredSent[i] as any)?.name ?? "Member", relationship: (insuredSent[i] as any)?.relationship ?? "" }))
          .filter((c: any) => c.case_id && c.case_number),
      });
      onSaved(`Family "${name.trim()}" created — ${outcomes.length} insured, ${sent.length - outcomes.length} nominee${sent.length - outcomes.length === 1 ? "" : "s"}.`, { id: familyId, isNew: false });
      onClose();
    } catch (err: any) {
      setError(readError(err, "Failed to create the family."));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const tabs: { id: Tab; label: string }[] = [
    { id: "family", label: "Family Details" },
    { id: "policy", label: "Policy Type" },
    { id: "members", label: `Family Members (${rows.length})` },
  ];
  const label = "block text-xs font-semibold text-slate-600";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-5xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
          <div>
            <h3 className="text-base font-bold text-slate-900">Add New Family</h3>
            <p className="text-xs text-slate-500 mt-0.5">Household, policy and members in one place — or upload a document to fill all three tabs.</p>
          </div>
          <div className="flex items-center gap-3">
            <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
            <button type="button" onClick={() => fileRef.current?.click()} disabled={extracting || saving}
              title="Upload a PDF, PNG or JPG (max 10 MB) to fill the form automatically"
              className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-blue-200 bg-white text-blue-700 hover:bg-blue-50 disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors">
              {extracting ? (
                <>
                  <span className="relative w-7 h-7 shrink-0">
                    <svg className="w-7 h-7 -rotate-90" viewBox="0 0 28 28" aria-hidden="true">
                      <circle cx="14" cy="14" r="12" fill="none" stroke="#dbeafe" strokeWidth="3" />
                      <circle cx="14" cy="14" r="12" fill="none" stroke="#1d4ed8" strokeWidth="3" strokeLinecap="round"
                        strokeDasharray={2 * Math.PI * 12} strokeDashoffset={2 * Math.PI * 12 * (1 - progress / 100)} style={{ transition: "stroke-dashoffset 0.3s ease" }} />
                    </svg>
                    <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold tabular-nums text-blue-800">{progress}%</span>
                  </span>
                  {progress < 50 ? "Uploading…" : "Reading document…"}
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>
                  Upload document
                </>
              )}
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Close">✕</button>
          </div>
        </div>

        {/* Tabs */}
        <div className="px-6 border-b border-slate-100 bg-white flex flex-wrap gap-1">
          {tabs.map((t) => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)}
              className={`px-4 py-3 text-xs font-semibold border-b-2 transition-all ${tab === t.id ? "border-blue-600 text-blue-600" : "border-transparent text-slate-400 hover:text-slate-600"}`}>
              {t.label}
              {tabHasMissing[t.id] && <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-amber-500" title="Fields to fill in on this tab" />}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3.5 text-xs text-red-600 font-medium flex justify-between items-start gap-3">
              <span>{error}</span>
              <button type="button" onClick={() => setError("")} className="opacity-60 hover:opacity-100 leading-none">✕</button>
            </div>
          )}
          {notice && (
            <div className={`rounded-xl p-3.5 text-xs font-medium flex justify-between items-start gap-3 border ${notice.tone === "ok" ? "bg-emerald-50 border-emerald-200 text-emerald-700" : notice.tone === "warn" ? "bg-amber-50 border-amber-200 text-amber-800" : "bg-red-50 border-red-200 text-red-600"}`}>
              <span>{notice.text}</span>
              <button type="button" onClick={() => setNotice(null)} className="opacity-60 hover:opacity-100 leading-none">✕</button>
            </div>
          )}

          {tab === "family" && (
            <div className="space-y-4 max-w-3xl">
              <div className="space-y-1.5">
                <label className={label}>Family Name *</label>
                <input className={`${INPUT} ${hi("name", name)}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rehman Family" />
              </div>
              <div className="space-y-1.5">
                <label className={label}>Contact Person (Proposer)</label>
                <input className={`${INPUT} ${hi("contact_person", contactPerson)}`} value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} placeholder="e.g. Asad Rehman" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5"><label className={label}>Contact Email</label>
                  <input type="email" className={`${INPUT} ${hi("contact_email", contactEmail)}`} value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="family@example.com" /></div>
                <div className="space-y-1.5"><label className={label}>Contact Phone</label>
                  <input className={`${INPUT} ${hi("contact_phone", contactPhone)}`} value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="+92 300 1234567" /></div>
              </div>
              <div className="space-y-1.5">
                <label className={label}>Household Annual Income (PKR)</label>
                <input type="number" className={`${INPUT} ${hi("household_income", householdIncome)}`} value={householdIncome} onChange={(e) => setHouseholdIncome(e.target.value)} placeholder="2400000" />
                <p className="text-[11px] text-slate-400">Used for the floater&apos;s income-eligibility check — children and non-earning members don&apos;t have their own income.</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5"><label className={label}>City</label>
                  <input className={`${INPUT} ${hi("city", city)}`} value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Lahore" /></div>
                <div className="space-y-1.5"><label className={label}>Province</label>
                  <select className={`${INPUT} ${hi("province", province)}`} value={province} onChange={(e) => setProvince(e.target.value)}>
                    <option value="">Select province</option>
                    {PAKISTAN_PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select></div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <SourcePicker
                  sources={sources}
                  sourceId={acquisitionSourceId}
                  onChange={(src) => {
                    setAcquisitionSourceId(src?.id ?? "");
                    // An Agent source is a login of its own: picking one hands the lead to that agent's mobile app.
                    setAssignedAgentId(src?.user_id && agentOptions.some((a) => a.id === src.user_id) ? src.user_id : "");
                  }}
                  fieldClass="space-y-1.5"
                  labelClass={label}
                  selectClass={INPUT}
                />
              </div>
            </div>
          )}

          {tab === "policy" && (
            <div className="space-y-4 max-w-3xl">
              <div className="grid grid-cols-2 gap-3">
                {([["Floater", "Health Floater", "One shared sum insured for the whole family; every member is risk-scored individually."],
                   ["LifeBundle", "Life Bundle", "Each member picks their own life plan and cover; a bundle discount applies."]] as const).map(([k, title, text]) => (
                  <button key={k} type="button" onClick={() => setKind(k)}
                    className={`text-left rounded-xl border p-4 transition-all ${kind === k ? "border-blue-600 bg-blue-50/50 ring-1 ring-blue-600" : "border-slate-200 hover:border-slate-300"} ${flagged.has("policy_type") && kind === k ? "!border-amber-400" : ""}`}>
                    <p className="text-sm font-semibold text-slate-900">{title}</p>
                    <p className="text-xs text-slate-500 mt-1">{text}</p>
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-4">
                {isBundle ? (
                  <div className="space-y-1.5"><label className={label}>Bundle discount (%)</label>
                    <input type="number" className={`${INPUT} ${hi("discount", discount)}`} value={discount} onChange={(e) => setDiscount(e.target.value)} /></div>
                ) : (
                  <div className="space-y-1.5"><label className={label}>Total sum insured (PKR) *</label>
                    <input type="number" className={`${INPUT} ${hi("sum_insured", sumInsured)}`} value={sumInsured} onChange={(e) => setSumInsured(e.target.value)} /></div>
                )}
                <div className="space-y-1.5"><label className={label}>Term (years) *</label>
                  <input type="number" min="1" className={`${INPUT} ${hi("term", term)}`} value={term} onChange={(e) => setTerm(e.target.value)} /></div>
                <div className="space-y-1.5"><label className={label}>Effective date *</label>
                  <input type="date" className={`${INPUT} ${hi("effective", effective)}`} value={effective} onChange={(e) => setEffective(e.target.value)} /></div>
              </div>
            </div>
          )}

          {tab === "members" && (
            <FamilyMembersEditor rows={rows} onChange={(r) => setRows(r)} isBundle={isBundle} lifePlans={lifePlans} flagged={flagged}
              baseAmount={isBundle ? parseFloat(rows.find((r) => r.kind === "Self")?.coverage_amount || "0") || 0 : parseFloat(sumInsured) || 0} />
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between gap-3">
          <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 bg-white rounded-lg hover:bg-slate-50">Cancel</button>
          <div className="flex items-center gap-2">
            {tab !== "family" && <button type="button" onClick={() => setTab(tab === "members" ? "policy" : "family")} className="px-4 py-2 text-xs font-semibold text-slate-700 border border-slate-200 bg-white rounded-lg hover:bg-slate-50">Back</button>}
            {tab !== "members" ? (
              <button type="button" onClick={() => setTab(tab === "family" ? "policy" : "members")} className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">Next</button>
            ) : (
              <button type="button" onClick={submit} disabled={saving || extracting} className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 rounded-lg">
                {saving ? "Creating…" : "Create family & enrol"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
