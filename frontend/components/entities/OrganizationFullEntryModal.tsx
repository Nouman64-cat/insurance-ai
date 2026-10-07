"use client";

// "Add New Corporate" with complete details, in one window and six tabs:
//   1. Company details   2. Group policy   3. Benefit classes (with extra benefits)
//   4. Employees (the census)   5. Dependants   6. Nominees
// Mirrors the individual customer's full-entry form, including "Upload document": a PDF / PNG / JPG
// describing the company's scheme fills all four tabs. Nothing is written until the last tab's
// "Create corporate & enrol" — then the organization, its master policy, its benefit classes, its employee
// census, and the employees' dependants and nominees are created in that order (a retry after a failure
// continues where it stopped).

import { Fragment, useEffect, useRef, useState } from "react";
import api, { OCR_BASE_URL } from "@/app/services/api";
import { listBranches, Branch } from "@/app/services/branches";
import { listAgents, Agent } from "@/app/services/agents";
import { listInsurancePlans, InsurancePlan } from "@/app/services/insurancePlans";
import { PAKISTAN_PROVINCES } from "@/lib/pakistanProvinces";
import { notifyParentPortal } from "@/lib/agent/portalMessage";

interface Props {
  open: boolean;
  onClose: () => void;
  /** `isNew` is true when setup should continue on the organization's page (quote, issuance). */
  onSaved: (message: string, entity: { id: string; isNew: boolean }) => void;
}

type Tab = "company" | "policy" | "classes" | "employees" | "dependants" | "nominees";

type Basis = "Flat" | "SalaryMultiple" | "ServiceBanded" | "LoanBalance";
interface Coverage { coverage_type: string; percent_of_base: string; max_amount: string }
interface ClassRow {
  name: string; basis: Basis; flat_amount: string; salary_multiple: string; bands: string; grades: string;
  min_cover: string; max_cover: string; is_default: boolean; coverages: Coverage[];
}
interface EmployeeRow {
  uid: number;
  cnic: string; name: string; dob: string; gender: string; occupation: string; declared_income: string;
  employee_id: string; designation: string; grade: string; joining_date: string; basic_monthly_salary: string; benefit_class: string;
  is_smoker: string; height_cm: string; weight_kg: string; loan_amount: string;
}
interface DependantRow { uid: number; emp: number | null; name: string; relationship: string; dob: string; cnic: string; gender: string; covered_amount: string }
interface NomineeRow { uid: number; emp: number | null; name: string; relationship: string; cnic: string; share_pct: string; dob: string; is_minor: boolean; guardian_name: string }

const RIDERS: Record<string, string> = { AccidentalDeath: "Accidental Death", Disability: "Disability", PayContinuation: "Pay Continuation", FeeContinuation: "Fee Continuation" };
let nextUid = 1;
const uid = () => nextUid++;

const BLANK_CLASS: ClassRow = { name: "", basis: "SalaryMultiple", flat_amount: "", salary_multiple: "24", bands: "", grades: "", min_cover: "", max_cover: "", is_default: false, coverages: [] };
const blankEmployee = (): EmployeeRow => ({
  uid: uid(), cnic: "", name: "", dob: "", gender: "Male", occupation: "", declared_income: "",
  employee_id: "", designation: "", grade: "", joining_date: "", basic_monthly_salary: "", benefit_class: "",
  is_smoker: "", height_cm: "", weight_kg: "", loan_amount: "",
});
const blankDependant = (emp: number | null = null): DependantRow => ({ uid: uid(), emp, name: "", relationship: "Spouse", dob: "", cnic: "", gender: "", covered_amount: "" });
const blankNominee = (emp: number | null = null): NomineeRow => ({ uid: uid(), emp, name: "", relationship: "Spouse", cnic: "", share_pct: "", dob: "", is_minor: false, guardian_name: "" });
const todayIso = () => new Date().toISOString().slice(0, 10);

function formatCNIC(value: string): string {
  const v = value.replace(/\D/g, "");
  let res = "";
  if (v.length > 0) res += v.substring(0, 5);
  if (v.length > 5) res += "-" + v.substring(5, 12);
  if (v.length > 12) res += "-" + v.substring(12, 13);
  return res;
}

const INPUT = "w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all";
const CELL = "w-full bg-slate-50 border border-slate-200 rounded-md px-2 py-1 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500";
const AMBER = "!border-amber-400 !bg-amber-50";
const EMPLOYEE_REQUIRED: [keyof EmployeeRow, string][] = [["cnic", "CNIC"], ["name", "name"], ["dob", "date of birth"], ["gender", "gender"], ["occupation", "occupation"], ["declared_income", "annual income"]];

export default function OrganizationFullEntryModal({ open, onClose, onSaved }: Props) {
  const [tab, setTab] = useState<Tab>("company");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);

  // Tab 1
  const [name, setName] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [industry, setIndustry] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [city, setCity] = useState("");
  const [province, setProvince] = useState("");
  const [branchId, setBranchId] = useState("");
  const [assignedAgentId, setAssignedAgentId] = useState("");
  const [branchOptions, setBranchOptions] = useState<Branch[]>([]);
  const [agentOptions, setAgentOptions] = useState<Agent[]>([]);

  // Tab 2
  const [plans, setPlans] = useState<InsurancePlan[]>([]);
  const [planCode, setPlanCode] = useState("GROUP_LIFE");
  const [multiple, setMultiple] = useState("24");
  const [term, setTerm] = useState("1");
  const [effective, setEffective] = useState(todayIso());

  // Tabs 3–6
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeRow[]>(() => [blankEmployee()]);
  const [dependants, setDependants] = useState<DependantRow[]>([]);
  const [nominees, setNominees] = useState<NomineeRow[]>([]);
  const [newBenefit, setNewBenefit] = useState<{ cls: number; type: string; pct: string; max: string } | null>(null);

  // Upload
  const fileRef = useRef<HTMLInputElement>(null);
  const [extracting, setExtracting] = useState(false);
  const [progress, setProgress] = useState(0);
  // Keys the document did not contain — highlighted while still empty.
  const [flagged, setFlagged] = useState<Set<string>>(new Set());

  // What exists already, so a retry after a failed step doesn't duplicate it.
  const created = useRef<{ orgId?: string; mpId?: string; classNames: Set<string>; memberByUid: Map<number, string>; depsDone: Set<number>; nomsDone: Set<number>; enrolled?: any }>(
    { classNames: new Set(), memberByUid: new Map(), depsDone: new Set(), nomsDone: new Set() });

  const plan = plans.find((p) => p.code === planCode);
  const minGroup = plan?.min_group_size ?? null;
  const showLoan = planCode === "GROUP_CREDIT_LIFE" || classes.some((c) => c.basis === "LoanBalance");
  const empty = (v: unknown) => v === undefined || v === null || String(v).trim() === "";

  useEffect(() => {
    if (!open) return;
    setTab("company"); setError(""); setNotice(null); setFlagged(new Set()); setNewBenefit(null);
    setName(""); setRegistrationNumber(""); setIndustry(""); setContactPerson(""); setContactEmail(""); setContactPhone("");
    setCity(""); setProvince(""); setBranchId(""); setAssignedAgentId("");
    setPlanCode("GROUP_LIFE"); setMultiple("24"); setTerm("1"); setEffective(todayIso());
    setClasses([]); setEmployees([blankEmployee()]); setDependants([]); setNominees([]);
    created.current = { classNames: new Set(), memberByUid: new Map(), depsDone: new Set(), nomsDone: new Set() };
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    listAgents(tenantId).then(setAgentOptions).catch(() => setAgentOptions([]));
    listBranches(tenantId).then(setBranchOptions).catch(() => setBranchOptions([]));
    listInsurancePlans(tenantId)
      .then((all) => setPlans(all.filter((p) => p.category === "Group" && p.is_active)))
      .catch(() => setPlans([]));
  }, [open]);

  const miss = (key: string, value: unknown) => flagged.has(key) && empty(value);
  const hi = (key: string, value: unknown) => (miss(key, value) ? AMBER : "");
  const cm = (kind: string, id: number | string, f: string, value: unknown) => flagged.has(`${kind}.${id}.${f}`) && empty(value);
  const amber = (kind: string, id: number | string, f: string, value: unknown) => (cm(kind, id, f, value) ? AMBER : "");

  const rowHasMissing = (kind: string, rows: { uid?: number }[], keys: string[], valueOf: (r: any, k: string) => unknown) =>
    rows.some((r, i) => keys.some((k) => cm(kind, kind === "class" ? i : (r.uid as number), k, valueOf(r, k))));
  const tabHasMissing: Record<Tab, boolean> = {
    company: [["name", name], ["registration_number", registrationNumber], ["industry", industry], ["contact_person", contactPerson], ["contact_email", contactEmail], ["contact_phone", contactPhone], ["city", city], ["province", province]]
      .some(([k, v]) => miss(k as string, v)),
    policy: [["plan", planCode], ["multiple", multiple], ["term", term], ["effective", effective]].some(([k, v]) => miss(k as string, v)),
    classes: flagged.has("classes") || rowHasMissing("class", classes as any, ["name", "flat_amount", "salary_multiple", "bands"], (r, k) => r[k]),
    employees: flagged.has("employees") || rowHasMissing("emp", employees, Object.keys(blankEmployee()).filter((k) => k !== "uid"), (r, k) => r[k]),
    dependants: rowHasMissing("dep", dependants, ["emp", "name", "relationship", "dob", "covered_amount"], (r, k) => r[k]),
    nominees: rowHasMissing("nom", nominees, ["emp", "name", "relationship", "share_pct"], (r, k) => r[k]),
  };

  const setEmp = (id: number, f: keyof EmployeeRow, v: string) =>
    setEmployees((prev) => prev.map((r) => (r.uid === id ? { ...r, [f]: f === "cnic" ? formatCNIC(v) : v } : r)));
  const setCls = (i: number, patch: Partial<ClassRow>) => setClasses((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setDep = (id: number, patch: Partial<DependantRow>) => setDependants((prev) => prev.map((r) => (r.uid === id ? { ...r, ...patch, ...(patch.cnic !== undefined ? { cnic: formatCNIC(patch.cnic) } : {}) } : r)));
  const setNom = (id: number, patch: Partial<NomineeRow>) => setNominees((prev) => prev.map((r) => (r.uid === id ? { ...r, ...patch, ...(patch.cnic !== undefined ? { cnic: formatCNIC(patch.cnic) } : {}) } : r)));
  const empLabel = (id: number | null) => {
    const e = employees.find((x) => x.uid === id);
    return e ? e.name.trim() || e.employee_id || "(unnamed employee)" : "";
  };

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
        xhr.open("POST", `${OCR_BASE_URL}/extract-organization`);
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

      const missing = new Set<string>();
      const take = (key: string, value: unknown, apply: (v: any) => void) => { if (empty(value)) missing.add(key); else apply(value); };

      const c = data.company || {};
      take("name", c.name, setName);
      take("registration_number", c.registration_number, setRegistrationNumber);
      take("industry", c.industry, setIndustry);
      take("contact_person", c.contact_person, setContactPerson);
      take("contact_email", c.contact_email, setContactEmail);
      take("contact_phone", c.contact_phone, setContactPhone);
      take("city", c.city, setCity);
      take("province", c.province, (v) => ((PAKISTAN_PROVINCES as readonly string[]).includes(v) ? setProvince(v) : missing.add("province")));

      const p = data.policy || {};
      const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
      // Exact name or code first; otherwise the longest plan name the document's wording contains
      // ("Group Life — SME" must not settle for plain "Group Life").
      const wanted = p.plan_name ? norm(p.plan_name) : "";
      const matched = wanted
        ? plans.find((x) => norm(x.label) === wanted || norm(x.code) === wanted)
          ?? [...plans].sort((a, b) => b.label.length - a.label.length).find((x) => wanted.includes(norm(x.label)) || norm(x.label).includes(wanted))
        : undefined;
      if (matched) setPlanCode(matched.code); else missing.add("plan");
      take("multiple", p.sum_assured_multiple, (v) => setMultiple(String(v)));
      take("term", p.term_years, (v) => setTerm(String(v)));
      take("effective", p.effective_date, setEffective);

      const readClasses: any[] = Array.isArray(data.classes) ? data.classes : [];
      const nextClasses: ClassRow[] = readClasses.map((k, i) => {
        const basis: Basis = ["Flat", "SalaryMultiple", "ServiceBanded", "LoanBalance"].includes(k.basis) ? k.basis : "SalaryMultiple";
        const row: ClassRow = { ...BLANK_CLASS, basis, name: k.name ?? "", salary_multiple: "", coverages: [] };
        if (basis === "Flat") { if (empty(k.flat_amount)) missing.add(`class.${i}.flat_amount`); else row.flat_amount = String(k.flat_amount); }
        else if (basis === "SalaryMultiple") { if (empty(k.salary_multiple)) missing.add(`class.${i}.salary_multiple`); else row.salary_multiple = String(k.salary_multiple); }
        else if (basis === "ServiceBanded") {
          const bands = Array.isArray(k.service_bands) ? k.service_bands.filter((b: any) => !empty(b.min_years) && !empty(b.amount)) : [];
          if (bands.length) row.bands = bands.map((b: any) => `${b.min_years}:${b.amount}`).join(", "); else missing.add(`class.${i}.bands`);
        }
        if (Array.isArray(k.grades) && k.grades.length) row.grades = k.grades.join(", ");
        if (!empty(k.min_cover)) row.min_cover = String(k.min_cover);
        if (!empty(k.max_cover)) row.max_cover = String(k.max_cover);
        row.is_default = Boolean(k.is_default);
        row.coverages = (Array.isArray(k.coverages) ? k.coverages : [])
          .filter((v: any) => v.coverage_type in RIDERS && !empty(v.percent_of_base))
          .map((v: any) => ({ coverage_type: v.coverage_type, percent_of_base: String(v.percent_of_base), max_amount: empty(v.max_amount) ? "" : String(v.max_amount) }));
        return row;
      });
      setClasses(nextClasses);

      const readEmployees: any[] = Array.isArray(data.employees) ? data.employees : [];
      const nextEmployees: EmployeeRow[] = readEmployees.map((e) => {
        const row: EmployeeRow = { ...blankEmployee(), gender: "" };
        (["cnic", "name", "dob", "gender", "occupation", "declared_income"] as (keyof EmployeeRow)[]).forEach((f) => {
          if (empty(e[f])) missing.add(`emp.${row.uid}.${f}`); else (row[f] as string) = f === "cnic" ? formatCNIC(String(e[f])) : String(e[f]);
        });
        (["employee_id", "designation", "grade", "joining_date", "basic_monthly_salary", "benefit_class", "height_cm", "weight_kg", "loan_amount"] as (keyof EmployeeRow)[])
          .forEach((f) => { if (!empty(e[f])) (row[f] as string) = String(e[f]); });
        if (e.is_smoker !== null && e.is_smoker !== undefined) row.is_smoker = String(Boolean(e.is_smoker));
        return row;
      });
      if (nextEmployees.length) setEmployees(nextEmployees); else missing.add("employees");

      // A dependant or nominee is tied to an employee by employee ID or CNIC in the document.
      const refTo = (ref: unknown): number | null => {
        const r = String(ref ?? "").trim().toLowerCase();
        if (!r) return null;
        const hit = nextEmployees.find((e) => e.employee_id.toLowerCase() === r || e.cnic.replace(/\D/g, "") === r.replace(/\D/g, "") || e.name.toLowerCase() === r);
        return hit ? hit.uid : null;
      };
      const nextDeps: DependantRow[] = (Array.isArray(data.dependants) ? data.dependants : []).map((d: any) => {
        const row = blankDependant(refTo(d.employee_ref));
        if (row.emp === null) missing.add(`dep.${row.uid}.emp`);
        (["name", "relationship", "dob", "cnic", "gender"] as const).forEach((f) => { if (!empty(d[f])) row[f] = f === "cnic" ? formatCNIC(String(d[f])) : String(d[f]); });
        if (!["Spouse", "Child", "Parent"].includes(row.relationship)) { row.relationship = "Spouse"; missing.add(`dep.${row.uid}.relationship`); }
        (["name", "dob"] as const).forEach((f) => { if (empty(row[f])) missing.add(`dep.${row.uid}.${f}`); });
        if (empty(d.covered_amount)) missing.add(`dep.${row.uid}.covered_amount`); else row.covered_amount = String(d.covered_amount);
        return row;
      });
      const nextNoms: NomineeRow[] = (Array.isArray(data.nominees) ? data.nominees : []).map((n: any) => {
        const row = blankNominee(refTo(n.employee_ref));
        if (row.emp === null) missing.add(`nom.${row.uid}.emp`);
        (["name", "relationship", "cnic", "guardian_name"] as const).forEach((f) => { if (!empty(n[f])) row[f] = f === "cnic" ? formatCNIC(String(n[f])) : String(n[f]); });
        if (!empty(n.date_of_birth)) row.dob = String(n.date_of_birth);
        row.is_minor = Boolean(n.is_minor);
        if (empty(row.name)) missing.add(`nom.${row.uid}.name`);
        if (empty(n.share_pct)) missing.add(`nom.${row.uid}.share_pct`); else row.share_pct = String(n.share_pct);
        return row;
      });
      setDependants(nextDeps);
      setNominees(nextNoms);
      setFlagged(missing);

      const filled = Number(data.found) || 0;
      const counts = `${nextClasses.length} class${nextClasses.length === 1 ? "" : "es"}, ${nextEmployees.length} employee${nextEmployees.length === 1 ? "" : "s"}, ${nextDeps.length} dependant${nextDeps.length === 1 ? "" : "s"}, ${nextNoms.length} nominee${nextNoms.length === 1 ? "" : "s"}`;
      setNotice(
        filled === 0
          ? { tone: "warn", text: "No company details could be read from this document. Please fill the tabs manually." }
          : missing.size === 0
          ? { tone: "ok", text: `Filled ${filled} fields (${counts}) from ${file.name}. Please review them before saving.` }
          : { tone: "warn", text: `Filled ${filled} fields (${counts}) from ${file.name}. ${missing.size} value${missing.size === 1 ? "" : "s"} not found in the document ${missing.size === 1 ? "is" : "are"} highlighted — please fill ${missing.size === 1 ? "it" : "them"} in.` },
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

  // "0:500000, 3:800000" → [{min_years: 0, amount: 500000}, …]; null when it doesn't parse.
  const parseBands = (text: string): { min_years: number; amount: number }[] | null => {
    const out = text.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
      const [y, a] = x.split(":").map((v) => parseFloat(v.trim()));
      return { min_years: y, amount: a };
    });
    return out.length && out.every((b) => Number.isFinite(b.min_years) && Number.isFinite(b.amount)) ? out : null;
  };

  const classBody = (c: ClassRow) => ({
    name: c.name.trim(), basis: c.basis, is_default: c.is_default,
    ...(c.basis === "Flat" ? { flat_amount: parseFloat(c.flat_amount) } : {}),
    ...(c.basis === "SalaryMultiple" ? { salary_multiple: parseFloat(c.salary_multiple) } : {}),
    ...(c.basis === "ServiceBanded" ? { service_bands: parseBands(c.bands) } : {}),
    ...(c.grades.trim() ? { grades: c.grades.split(",").map((g) => g.trim()).filter(Boolean) } : {}),
    ...(c.min_cover ? { min_cover: parseFloat(c.min_cover) } : {}),
    ...(c.max_cover ? { max_cover: parseFloat(c.max_cover) } : {}),
    ...(c.coverages.length ? { coverages: c.coverages.map((v) => ({ coverage_type: v.coverage_type, percent_of_base: parseFloat(v.percent_of_base), ...(v.max_amount ? { max_amount: parseFloat(v.max_amount) } : {}) })) } : {}),
  });

  const employeeBody = (e: EmployeeRow) => ({
    cnic: e.cnic, name: e.name, dob: e.dob, gender: e.gender, occupation: e.occupation, declared_income: parseFloat(e.declared_income) || 0,
    ...(e.employee_id ? { employee_id: e.employee_id } : {}), ...(e.designation ? { designation: e.designation } : {}),
    ...(e.grade ? { grade: e.grade } : {}), ...(e.joining_date ? { joining_date: e.joining_date } : {}),
    ...(e.basic_monthly_salary ? { basic_monthly_salary: parseFloat(e.basic_monthly_salary) } : {}),
    ...(e.benefit_class ? { benefit_class: e.benefit_class } : {}),
    ...(e.is_smoker !== "" ? { is_smoker: e.is_smoker === "true" } : {}),
    ...(e.height_cm ? { height_cm: parseFloat(e.height_cm) } : {}), ...(e.weight_kg ? { weight_kg: parseFloat(e.weight_kg) } : {}),
    ...(e.loan_amount ? { loan_amount: parseFloat(e.loan_amount) } : {}),
  });

  const submit = async () => {
    setError("");
    const flag = (keys: string[]) => setFlagged((prev) => { const n = new Set(prev); keys.forEach((k) => n.add(k)); return n; });
    const stop = (t: Tab, problems: string[]) => { setTab(t); setError(problems.slice(0, 4).join("; ") + (problems.length > 4 ? `; …and ${problems.length - 4} more` : "")); };

    if (!name.trim()) { stop("company", ["Company name is required."]); return; }
    if (!(parseFloat(multiple) > 0) || !(parseInt(term) > 0) || !effective) { stop("policy", ["The group policy needs a sum assured multiple, a term and an effective date."]); return; }

    // Check everything up front, so a typo doesn't leave a company and policy with no employees.
    const classProblems: string[] = [];
    classes.forEach((c, i) => {
      if (empty(c.name)) { classProblems.push(`Class ${i + 1}: name is missing`); flag([`class.${i}.name`]); }
      if (c.basis === "Flat" && !(parseFloat(c.flat_amount) > 0)) { classProblems.push(`Class ${i + 1}: flat amount is missing`); flag([`class.${i}.flat_amount`]); }
      if (c.basis === "SalaryMultiple" && !(parseFloat(c.salary_multiple) > 0)) { classProblems.push(`Class ${i + 1}: salary multiple is missing`); flag([`class.${i}.salary_multiple`]); }
      if (c.basis === "ServiceBanded" && !parseBands(c.bands)) { classProblems.push(`Class ${i + 1}: service bands should look like 0:500000, 3:800000`); flag([`class.${i}.bands`]); }
      c.coverages.forEach((v) => { if (!(parseFloat(v.percent_of_base) > 0)) classProblems.push(`Class ${i + 1}: ${RIDERS[v.coverage_type]} needs a percentage`); });
    });
    if (classProblems.length) { stop("classes", classProblems); return; }

    const empProblems: string[] = [];
    employees.forEach((r, i) => EMPLOYEE_REQUIRED.forEach(([f, t]) => { if (empty(r[f])) { empProblems.push(`Employee ${i + 1}: ${t} is missing`); flag([`emp.${r.uid}.${f}`]); } }));
    const cnics = employees.map((r) => r.cnic).filter(Boolean);
    if (new Set(cnics).size !== cnics.length) empProblems.push("Two employees have the same CNIC");
    if (minGroup && employees.length < minGroup) empProblems.push(`${plan?.label ?? "This plan"} needs at least ${minGroup} employees (you have ${employees.length})`);
    const classNames = new Set(classes.map((c) => c.name.trim().toLowerCase()));
    employees.forEach((r, i) => { if (r.benefit_class && !classNames.has(r.benefit_class.trim().toLowerCase())) empProblems.push(`Employee ${i + 1}: class “${r.benefit_class}” isn't one of the benefit classes`); });
    if (empProblems.length) { stop("employees", empProblems); return; }

    const depProblems: string[] = [];
    dependants.forEach((d, i) => {
      ([["emp", "employee"], ["name", "name"], ["dob", "date of birth"], ["covered_amount", "covered amount"]] as const).forEach(([f, t]) => {
        if (empty(d[f])) { depProblems.push(`Dependant ${i + 1}: ${t} is missing`); flag([`dep.${d.uid}.${f}`]); }
      });
    });
    if (depProblems.length) { stop("dependants", depProblems); return; }

    const nomProblems: string[] = [];
    nominees.forEach((n, i) => {
      ([["emp", "employee"], ["name", "name"], ["share_pct", "share %"]] as const).forEach(([f, t]) => {
        if (empty(n[f])) { nomProblems.push(`Nominee ${i + 1}: ${t} is missing`); flag([`nom.${n.uid}.${f}`]); }
      });
    });
    const shares = new Map<number, number>();
    nominees.forEach((n) => { if (n.emp !== null) shares.set(n.emp, (shares.get(n.emp) ?? 0) + (parseFloat(n.share_pct) || 0)); });
    shares.forEach((total, id) => { if (Math.abs(total - 100) > 0.01) nomProblems.push(`${empLabel(id)}'s nominee shares total ${total}% — they must total 100%`); });
    if (nomProblems.length) { stop("nominees", nomProblems); return; }

    setSaving(true);
    const tenantId = localStorage.getItem("tenant_id");
    const st = created.current;
    try {
      if (!st.orgId) {
        const resp = await api.post(`/tenants/${tenantId}/organizations`, {
          name: name.trim(), registration_number: registrationNumber || null, industry: industry || null,
          contact_person: contactPerson || null, contact_email: contactEmail || null, contact_phone: contactPhone || null,
          city: city || null, province: province || null, branch_id: branchId || null, assigned_agent_id: assignedAgentId || null,
        });
        st.orgId = resp.data.id;
      }
      const orgId = st.orgId!;

      if (!st.mpId) {
        const resp = await api.post(`/tenants/${tenantId}/organizations/${orgId}/master-policies`, {
          sum_assured_multiple: parseFloat(multiple), term_years: parseInt(term), effective_date: effective, plan_code: planCode,
        });
        st.mpId = resp.data.id;
      }
      const mpBase = `/tenants/${tenantId}/organizations/${orgId}/master-policies/${st.mpId}`;

      // Classes first — they are frozen once employees are enrolled.
      for (const c of classes) {
        const key = c.name.trim().toLowerCase();
        if (st.classNames.has(key)) continue;
        try {
          await api.post(`${mpBase}/benefit-classes`, classBody(c));
          st.classNames.add(key);
        } catch (err: any) {
          stop("classes", [`The company and its policy were created, but class “${c.name}” was not: ${readError(err, "Failed to add the class.")} Fix it and press the button again.`]);
          return;
        }
      }

      if (!st.enrolled) {
        try {
          st.enrolled = (await api.post(`${mpBase}/census/confirm`, { employees: employees.map(employeeBody) })).data;
          // Outcomes come back in the order the employees were sent.
          employees.forEach((e, i) => { const id = st.enrolled.employees?.[i]?.group_member_id; if (id) st.memberByUid.set(e.uid, id); });
        } catch (err: any) {
          stop("employees", [`The company, policy and classes were created, but the employees were not enrolled: ${readError(err, "Failed to enrol the employees.")} Fix the rows and press the button again.`]);
          return;
        }
      }

      // Dependants and nominees hang off each enrolled employee. A failure here leaves the scheme intact:
      // say what is left and let the button be pressed again — only the unfinished ones are retried.
      const failures: { tab: Tab; text: string }[] = [];
      for (const d of dependants) {
        if (st.depsDone.has(d.uid)) continue;
        const memberId = d.emp !== null ? st.memberByUid.get(d.emp) : undefined;
        if (!memberId) { failures.push({ tab: "dependants", text: `${d.name}: ${empLabel(d.emp)} was not enrolled` }); continue; }
        try {
          await api.post(`${mpBase}/members/${memberId}/dependents`, {
            name: d.name.trim(), relationship: d.relationship, dob: d.dob, covered_amount: parseFloat(d.covered_amount),
            ...(d.cnic ? { cnic: d.cnic } : {}), ...(d.gender ? { gender: d.gender } : {}),
          });
          st.depsDone.add(d.uid);
        } catch (err: any) { failures.push({ tab: "dependants", text: `${d.name} (${empLabel(d.emp)}): ${readError(err, "could not be added")}` }); }
      }
      const nomineeGroups = new Map<number, NomineeRow[]>();
      nominees.forEach((n) => { if (n.emp !== null) nomineeGroups.set(n.emp, [...(nomineeGroups.get(n.emp) ?? []), n]); });
      for (const [empUid, list] of Array.from(nomineeGroups.entries())) {
        if (list.every((n) => st.nomsDone.has(n.uid))) continue;
        const memberId = st.memberByUid.get(empUid);
        if (!memberId) { failures.push({ tab: "nominees", text: `${empLabel(empUid)} was not enrolled` }); continue; }
        try {
          await api.put(`${mpBase}/members/${memberId}/beneficiaries`, {
            beneficiaries: list.map((n) => ({
              name: n.name.trim(), relationship: n.relationship, share_pct: parseFloat(n.share_pct), is_minor: n.is_minor,
              ...(n.cnic ? { cnic: n.cnic } : {}), ...(n.dob ? { date_of_birth: n.dob } : {}), ...(n.guardian_name ? { guardian_name: n.guardian_name } : {}),
            })),
            changed_by: "Entered with the corporate", change_reason: "Initial nomination",
          });
          list.forEach((n) => st.nomsDone.add(n.uid));
        } catch (err: any) { failures.push({ tab: "nominees", text: `${empLabel(empUid)}: ${readError(err, "nominees could not be saved")}` }); }
      }
      if (failures.length) {
        stop(failures[0].tab, [`The corporate and its employees were created, but some extras were not saved — ${failures.slice(0, 3).map((f) => f.text).join("; ")}${failures.length > 3 ? `; …and ${failures.length - 3} more` : ""}. Fix them and press the button again, or add them later from the Members tab.`]);
        return;
      }

      // Embedded in the Copilot: close the window and let the chat carry on with the group scheme.
      notifyParentPortal("organization_enrolled", {
        organization_id: orgId, master_policy_id: st.mpId, name: name.trim(),
        employee_count: employees.length, plan_label: plan?.label ?? "Group Life", free_cover_limit: st.enrolled?.free_cover_limit ?? null,
      });
      onSaved(`Corporate "${name.trim()}" created with ${employees.length} employees enrolled.`, { id: orgId, isNew: true });
      onClose();
    } catch (err: any) {
      setError(readError(err, "Failed to create the corporate."));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const tabs: { id: Tab; label: string }[] = [
    { id: "company", label: "Company Details" },
    { id: "policy", label: "Group Policy" },
    { id: "classes", label: `Benefit Classes (${classes.length})` },
    { id: "employees", label: `Employees (${employees.length})` },
    { id: "dependants", label: `Dependants (${dependants.length})` },
    { id: "nominees", label: `Nominees (${nominees.length})` },
  ];
  const order: Tab[] = ["company", "policy", "classes", "employees", "dependants", "nominees"];
  const label = "block text-xs font-semibold text-slate-600";
  const empOptions = (
    <>
      <option value="">Select employee…</option>
      {employees.map((e) => <option key={e.uid} value={e.uid}>{e.name.trim() || e.employee_id || "(unnamed employee)"}{e.employee_id ? ` · ${e.employee_id}` : ""}</option>)}
    </>
  );
  const Th = ({ children }: { children?: React.ReactNode }) => <th className="px-2 py-2 text-left whitespace-nowrap">{children}</th>;
  const headRow = "bg-slate-50 text-[10px] font-semibold uppercase tracking-wider text-slate-400";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-6xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
          <div>
            <h3 className="text-base font-bold text-slate-900">Add New Corporate</h3>
            <p className="text-xs text-slate-500 mt-0.5">Company, group policy, benefit classes, employees, dependants and nominees in one place — or upload a document to fill every tab.</p>
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

          {tab === "company" && (
            <div className="space-y-4 max-w-3xl">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5"><label className={label}>Company Name *</label>
                  <input className={`${INPUT} ${hi("name", name)}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Meridian Textiles Ltd" /></div>
                <div className="space-y-1.5"><label className={label}>Registration Number</label>
                  <input className={`${INPUT} ${hi("registration_number", registrationNumber)}`} value={registrationNumber} onChange={(e) => setRegistrationNumber(e.target.value)} placeholder="e.g. 0123456" /></div>
              </div>
              <div className="space-y-1.5"><label className={label}>Industry</label>
                <input className={`${INPUT} ${hi("industry", industry)}`} value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="e.g. Textiles" /></div>
              <div className="space-y-1.5"><label className={label}>Contact Person</label>
                <input className={`${INPUT} ${hi("contact_person", contactPerson)}`} value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} placeholder="e.g. Sana Iqbal" /></div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5"><label className={label}>Contact Email</label>
                  <input type="email" className={`${INPUT} ${hi("contact_email", contactEmail)}`} value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="hr@company.com" /></div>
                <div className="space-y-1.5"><label className={label}>Contact Phone</label>
                  <input className={`${INPUT} ${hi("contact_phone", contactPhone)}`} value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="+92 300 1234567" /></div>
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
                <div className="space-y-1.5"><label className={label}>Branch</label>
                  <select className={INPUT} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                    <option value="">Unassigned</option>
                    {branchOptions.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select></div>
                <div className="space-y-1.5"><label className={label}>Assigned Agent</label>
                  <select className={INPUT} value={assignedAgentId} onChange={(e) => setAssignedAgentId(e.target.value)}>
                    <option value="">Unassigned</option>
                    {agentOptions.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
                  </select></div>
              </div>
            </div>
          )}

          {tab === "policy" && (
            <div className="space-y-4 max-w-3xl">
              <div className="space-y-1.5">
                <label className={label}>Product *</label>
                <select className={`${INPUT} ${hi("plan", planCode)}`} value={planCode} onChange={(e) => setPlanCode(e.target.value)}>
                  {(plans.length ? plans : [{ code: "GROUP_LIFE", label: "Group Life" } as InsurancePlan]).map((p) => (
                    <option key={p.code} value={p.code}>{p.label}{p.product_category ? ` (${p.product_category})` : ""}</option>
                  ))}
                </select>
                {minGroup ? <p className="text-[11px] text-slate-400">This product needs at least {minGroup} employees.</p> : null}
                {plan?.product_category === "Takaful" && <p className="text-[11px] text-slate-400">Takaful: the employer pays a contribution, split between the Wakala fee and the Participants&apos; Takaful Fund.</p>}
                {planCode === "GROUP_CREDIT_LIFE" && <p className="text-[11px] text-slate-400">Credit life: cover follows each borrower&apos;s outstanding loan — use the &ldquo;Loan balance&rdquo; basis on a class and give each employee a loan amount.</p>}
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-1.5"><label className={label}>Default cover (× monthly basic salary) *</label>
                  <input type="number" step="0.5" className={`${INPUT} ${hi("multiple", multiple)}`} value={multiple} onChange={(e) => setMultiple(e.target.value)} />
                  <p className="text-[11px] text-slate-400">Between 12× and 36×. Used for employees in no benefit class.</p></div>
                <div className="space-y-1.5"><label className={label}>Term (years) *</label>
                  <input type="number" min="1" className={`${INPUT} ${hi("term", term)}`} value={term} onChange={(e) => setTerm(e.target.value)} /></div>
                <div className="space-y-1.5"><label className={label}>Effective date *</label>
                  <input type="date" className={`${INPUT} ${hi("effective", effective)}`} value={effective} onChange={(e) => setEffective(e.target.value)} /></div>
              </div>
            </div>
          )}

          {tab === "classes" && (
            <div className="space-y-3">
              <p className="text-xs text-slate-500">
                Who gets how much cover, and which extra benefits come with it. Optional — employees in no class get the default multiple from the policy tab. Classes are locked once the employees are enrolled.
              </p>
              {classes.length > 0 && (
                <div className="overflow-x-auto border border-slate-100 rounded-lg">
                  <table className="w-full text-xs">
                    <thead><tr className={headRow}>{["Class name", "Basis", "Amount / multiple / bands", "Grades", "Min cover", "Max cover", "Default", ""].map((h) => <Th key={h}>{h}</Th>)}</tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {classes.map((c, i) => (
                        <Fragment key={i}>
                          <tr>
                            <td className="px-1.5 py-1.5 min-w-[140px]"><input className={`${CELL} ${amber("class", i, "name", c.name)}`} value={c.name} onChange={(e) => setCls(i, { name: e.target.value })} placeholder="Management" /></td>
                            <td className="px-1.5 py-1.5">
                              <select className={CELL} value={c.basis} onChange={(e) => setCls(i, { basis: e.target.value as Basis })}>
                                <option value="SalaryMultiple">Salary multiple</option><option value="Flat">Flat amount</option><option value="ServiceBanded">By years of service</option>
                                {(showLoan || c.basis === "LoanBalance") && <option value="LoanBalance">Loan balance</option>}
                              </select>
                            </td>
                            <td className="px-1.5 py-1.5 min-w-[170px]">
                              {c.basis === "Flat" && <input type="number" className={`${CELL} ${amber("class", i, "flat_amount", c.flat_amount)}`} value={c.flat_amount} onChange={(e) => setCls(i, { flat_amount: e.target.value })} placeholder="PKR" />}
                              {c.basis === "SalaryMultiple" && <input type="number" step="0.5" className={`${CELL} ${amber("class", i, "salary_multiple", c.salary_multiple)}`} value={c.salary_multiple} onChange={(e) => setCls(i, { salary_multiple: e.target.value })} placeholder="× salary" />}
                              {c.basis === "ServiceBanded" && <input className={`${CELL} ${amber("class", i, "bands", c.bands)}`} value={c.bands} onChange={(e) => setCls(i, { bands: e.target.value })} placeholder="0:500000, 3:800000" title="Completed years of service : cover" />}
                              {c.basis === "LoanBalance" && <span className="text-[11px] text-slate-400">The borrower&apos;s loan amount</span>}
                            </td>
                            <td className="px-1.5 py-1.5 min-w-[110px]"><input className={CELL} value={c.grades} onChange={(e) => setCls(i, { grades: e.target.value })} placeholder="M1, M2" /></td>
                            <td className="px-1.5 py-1.5 min-w-[100px]"><input type="number" className={CELL} value={c.min_cover} onChange={(e) => setCls(i, { min_cover: e.target.value })} /></td>
                            <td className="px-1.5 py-1.5 min-w-[100px]"><input type="number" className={CELL} value={c.max_cover} onChange={(e) => setCls(i, { max_cover: e.target.value })} /></td>
                            <td className="px-1.5 py-1.5 text-center"><input type="checkbox" checked={c.is_default} onChange={(e) => setClasses((prev) => prev.map((r, j) => ({ ...r, is_default: j === i ? e.target.checked : e.target.checked ? false : r.is_default })))} /></td>
                            <td className="px-1.5 py-1.5"><button type="button" onClick={() => { setClasses((p) => p.filter((_, j) => j !== i)); setNewBenefit(null); }} className="text-slate-300 hover:text-red-600" aria-label="Remove class">✕</button></td>
                          </tr>
                          <tr className="bg-slate-50/40">
                            <td colSpan={8} className="px-3 py-1.5">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Extra benefits</span>
                                {c.coverages.map((v, k) => (
                                  <span key={k} className="inline-flex items-center gap-1 text-[11px] border border-slate-200 bg-white rounded px-1.5 py-0.5 text-slate-700">
                                    {RIDERS[v.coverage_type]} {v.percent_of_base}%{v.max_amount ? ` (max ${Number(v.max_amount).toLocaleString()})` : ""}
                                    <button type="button" onClick={() => setCls(i, { coverages: c.coverages.filter((_, j) => j !== k) })} className="text-slate-400 hover:text-red-600" aria-label="Remove benefit">✕</button>
                                  </span>
                                ))}
                                {newBenefit?.cls === i ? (
                                  <>
                                    <select className={`${CELL} !w-auto`} value={newBenefit.type} onChange={(e) => setNewBenefit({ ...newBenefit, type: e.target.value })}>
                                      {Object.entries(RIDERS).filter(([k]) => !c.coverages.some((v) => v.coverage_type === k)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                                    </select>
                                    <input type="number" min="1" className={`${CELL} !w-20`} value={newBenefit.pct} onChange={(e) => setNewBenefit({ ...newBenefit, pct: e.target.value })} aria-label="Percent of life cover" />
                                    <span className="text-[11px] text-slate-400">% of life</span>
                                    <input type="number" min="1" className={`${CELL} !w-28`} placeholder="Max PKR" value={newBenefit.max} onChange={(e) => setNewBenefit({ ...newBenefit, max: e.target.value })} />
                                    <button type="button" disabled={!(parseFloat(newBenefit.pct) > 0)} onClick={() => { setCls(i, { coverages: [...c.coverages, { coverage_type: newBenefit.type, percent_of_base: newBenefit.pct, max_amount: newBenefit.max }] }); setNewBenefit(null); }}
                                      className="text-xs font-semibold text-white bg-blue-600 disabled:opacity-50 rounded px-2 py-1">Add</button>
                                    <button type="button" onClick={() => setNewBenefit(null)} className="text-xs text-slate-400">Cancel</button>
                                  </>
                                ) : c.coverages.length < Object.keys(RIDERS).length && (
                                  <button type="button" onClick={() => setNewBenefit({ cls: i, type: Object.keys(RIDERS).find((k) => !c.coverages.some((v) => v.coverage_type === k))!, pct: "100", max: "" })} className="text-[11px] font-semibold text-blue-600 hover:text-blue-800">+ Benefit</button>
                                )}
                              </div>
                            </td>
                          </tr>
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <button type="button" onClick={() => setClasses((p) => [...p, { ...BLANK_CLASS, coverages: [] }])} className="text-xs font-semibold text-blue-600 hover:text-blue-800">+ Add class</button>
            </div>
          )}

          {tab === "employees" && (
            <div className="space-y-3">
              <p className="text-xs text-slate-500">
                The employee census{minGroup ? ` — at least ${minGroup} for ${plan?.label}` : ""}. CNIC, name, date of birth, gender, occupation and annual income are required; the rest sharpens the cover calculation and underwriting.
              </p>
              <div className="overflow-x-auto border border-slate-100 rounded-lg">
                <table className="w-full text-xs">
                  <thead><tr className={headRow}>{["CNIC", "Full name", "DOB", "Gender", "Occupation", "Annual income", "Emp. ID", "Designation", "Grade", "Joined", "Monthly basic", "Class", "Smoker", "Height", "Weight", ...(showLoan ? ["Loan amount"] : []), ""].map((h) => <Th key={h}>{h}</Th>)}</tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {employees.map((r) => {
                      const cls = (f: keyof EmployeeRow) => `${CELL} ${amber("emp", r.uid, f, r[f])}`;
                      return (
                        <tr key={r.uid}>
                          <td className="px-1.5 py-1.5 min-w-[140px]"><input className={cls("cnic")} value={r.cnic} onChange={(e) => setEmp(r.uid, "cnic", e.target.value)} placeholder="35202-1234567-1" /></td>
                          <td className="px-1.5 py-1.5 min-w-[130px]"><input className={cls("name")} value={r.name} onChange={(e) => setEmp(r.uid, "name", e.target.value)} placeholder="Full name" /></td>
                          <td className="px-1.5 py-1.5 min-w-[120px]"><input type="date" className={cls("dob")} value={r.dob} onChange={(e) => setEmp(r.uid, "dob", e.target.value)} /></td>
                          <td className="px-1.5 py-1.5"><select className={cls("gender")} value={r.gender} onChange={(e) => setEmp(r.uid, "gender", e.target.value)}><option value="">—</option><option>Male</option><option>Female</option></select></td>
                          <td className="px-1.5 py-1.5 min-w-[110px]"><input className={cls("occupation")} value={r.occupation} onChange={(e) => setEmp(r.uid, "occupation", e.target.value)} placeholder="Job title" /></td>
                          <td className="px-1.5 py-1.5 min-w-[100px]"><input type="number" className={cls("declared_income")} value={r.declared_income} onChange={(e) => setEmp(r.uid, "declared_income", e.target.value)} placeholder="PKR / year" /></td>
                          <td className="px-1.5 py-1.5 w-[80px]"><input className={cls("employee_id")} value={r.employee_id} onChange={(e) => setEmp(r.uid, "employee_id", e.target.value)} /></td>
                          <td className="px-1.5 py-1.5 min-w-[110px]"><input className={cls("designation")} value={r.designation} onChange={(e) => setEmp(r.uid, "designation", e.target.value)} /></td>
                          <td className="px-1.5 py-1.5 w-[70px]"><input className={cls("grade")} value={r.grade} onChange={(e) => setEmp(r.uid, "grade", e.target.value)} /></td>
                          <td className="px-1.5 py-1.5 min-w-[120px]"><input type="date" className={cls("joining_date")} value={r.joining_date} onChange={(e) => setEmp(r.uid, "joining_date", e.target.value)} /></td>
                          <td className="px-1.5 py-1.5 min-w-[100px]"><input type="number" className={cls("basic_monthly_salary")} value={r.basic_monthly_salary} onChange={(e) => setEmp(r.uid, "basic_monthly_salary", e.target.value)} placeholder="PKR / month" /></td>
                          <td className="px-1.5 py-1.5 min-w-[120px]">
                            <select className={cls("benefit_class")} value={r.benefit_class} onChange={(e) => setEmp(r.uid, "benefit_class", e.target.value)}>
                              <option value="">{classes.length ? "By grade / default" : "—"}</option>
                              {classes.filter((c) => c.name.trim()).map((c) => <option key={c.name} value={c.name.trim()}>{c.name.trim()}</option>)}
                              {r.benefit_class && !classes.some((c) => c.name.trim() === r.benefit_class) && <option value={r.benefit_class}>{r.benefit_class} (no such class)</option>}
                            </select>
                          </td>
                          <td className="px-1.5 py-1.5"><select className={cls("is_smoker")} value={r.is_smoker} onChange={(e) => setEmp(r.uid, "is_smoker", e.target.value)}><option value="">—</option><option value="false">No</option><option value="true">Yes</option></select></td>
                          <td className="px-1.5 py-1.5 w-[70px]"><input type="number" className={cls("height_cm")} value={r.height_cm} onChange={(e) => setEmp(r.uid, "height_cm", e.target.value)} placeholder="cm" /></td>
                          <td className="px-1.5 py-1.5 w-[70px]"><input type="number" className={cls("weight_kg")} value={r.weight_kg} onChange={(e) => setEmp(r.uid, "weight_kg", e.target.value)} placeholder="kg" /></td>
                          {showLoan && <td className="px-1.5 py-1.5 min-w-[100px]"><input type="number" className={cls("loan_amount")} value={r.loan_amount} onChange={(e) => setEmp(r.uid, "loan_amount", e.target.value)} placeholder="PKR" /></td>}
                          <td className="px-1.5 py-1.5">{employees.length > 1 && <button type="button" onClick={() => { setEmployees((p) => p.filter((x) => x.uid !== r.uid)); setDependants((p) => p.filter((d) => d.emp !== r.uid)); setNominees((p) => p.filter((n) => n.emp !== r.uid)); }} className="text-slate-300 hover:text-red-600" aria-label="Remove employee">✕</button>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <button type="button" onClick={() => setEmployees((p) => [...p, blankEmployee()])} className="text-xs font-semibold text-blue-600 hover:text-blue-800">+ Add employee</button>
            </div>
          )}

          {tab === "dependants" && (
            <div className="space-y-3">
              <p className="text-xs text-slate-500">
                Spouses, children and parents the employer also covers. Optional. A dependant&apos;s cover can&apos;t exceed their employee&apos;s own cover — nominees (who only receive a payout) are on the next tab.
              </p>
              {dependants.length > 0 && (
                <div className="overflow-x-auto border border-slate-100 rounded-lg">
                  <table className="w-full text-xs">
                    <thead><tr className={headRow}>{["Employee", "Dependant name", "Relationship", "Date of birth", "CNIC", "Gender", "Covered amount", ""].map((h) => <Th key={h}>{h}</Th>)}</tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {dependants.map((d) => (
                        <tr key={d.uid}>
                          <td className="px-1.5 py-1.5 min-w-[160px]"><select className={`${CELL} ${amber("dep", d.uid, "emp", d.emp)}`} value={d.emp ?? ""} onChange={(e) => setDep(d.uid, { emp: e.target.value ? Number(e.target.value) : null })}>{empOptions}</select></td>
                          <td className="px-1.5 py-1.5 min-w-[140px]"><input className={`${CELL} ${amber("dep", d.uid, "name", d.name)}`} value={d.name} onChange={(e) => setDep(d.uid, { name: e.target.value })} /></td>
                          <td className="px-1.5 py-1.5"><select className={`${CELL} ${amber("dep", d.uid, "relationship", d.relationship)}`} value={d.relationship} onChange={(e) => setDep(d.uid, { relationship: e.target.value })}><option>Spouse</option><option>Child</option><option>Parent</option></select></td>
                          <td className="px-1.5 py-1.5 min-w-[120px]"><input type="date" className={`${CELL} ${amber("dep", d.uid, "dob", d.dob)}`} value={d.dob} onChange={(e) => setDep(d.uid, { dob: e.target.value })} /></td>
                          <td className="px-1.5 py-1.5 min-w-[140px]"><input className={CELL} value={d.cnic} onChange={(e) => setDep(d.uid, { cnic: e.target.value })} placeholder="optional" /></td>
                          <td className="px-1.5 py-1.5"><select className={CELL} value={d.gender} onChange={(e) => setDep(d.uid, { gender: e.target.value })}><option value="">—</option><option>Male</option><option>Female</option></select></td>
                          <td className="px-1.5 py-1.5 min-w-[110px]"><input type="number" className={`${CELL} ${amber("dep", d.uid, "covered_amount", d.covered_amount)}`} value={d.covered_amount} onChange={(e) => setDep(d.uid, { covered_amount: e.target.value })} placeholder="PKR" /></td>
                          <td className="px-1.5 py-1.5"><button type="button" onClick={() => setDependants((p) => p.filter((x) => x.uid !== d.uid))} className="text-slate-300 hover:text-red-600" aria-label="Remove dependant">✕</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <button type="button" onClick={() => setDependants((p) => [...p, blankDependant(employees.length === 1 ? employees[0].uid : null)])} className="text-xs font-semibold text-blue-600 hover:text-blue-800">+ Add dependant</button>
            </div>
          )}

          {tab === "nominees" && (
            <div className="space-y-3">
              <p className="text-xs text-slate-500">
                Who receives an employee&apos;s death benefit. Optional per employee, but when an employee has nominees their shares must total 100%. Nominees are not covered themselves.
              </p>
              {nominees.length > 0 && (
                <div className="overflow-x-auto border border-slate-100 rounded-lg">
                  <table className="w-full text-xs">
                    <thead><tr className={headRow}>{["Employee", "Nominee name", "Relationship", "CNIC", "Share %", "Date of birth", "Minor", "Guardian", ""].map((h) => <Th key={h}>{h}</Th>)}</tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {nominees.map((n) => (
                        <tr key={n.uid}>
                          <td className="px-1.5 py-1.5 min-w-[160px]"><select className={`${CELL} ${amber("nom", n.uid, "emp", n.emp)}`} value={n.emp ?? ""} onChange={(e) => setNom(n.uid, { emp: e.target.value ? Number(e.target.value) : null })}>{empOptions}</select></td>
                          <td className="px-1.5 py-1.5 min-w-[140px]"><input className={`${CELL} ${amber("nom", n.uid, "name", n.name)}`} value={n.name} onChange={(e) => setNom(n.uid, { name: e.target.value })} /></td>
                          <td className="px-1.5 py-1.5"><select className={`${CELL} ${amber("nom", n.uid, "relationship", n.relationship)}`} value={n.relationship} onChange={(e) => setNom(n.uid, { relationship: e.target.value })}><option>Spouse</option><option>Child</option><option>Parent</option><option>Sibling</option><option>Other</option></select></td>
                          <td className="px-1.5 py-1.5 min-w-[140px]"><input className={CELL} value={n.cnic} onChange={(e) => setNom(n.uid, { cnic: e.target.value })} placeholder="optional" /></td>
                          <td className="px-1.5 py-1.5 w-[80px]"><input type="number" className={`${CELL} ${amber("nom", n.uid, "share_pct", n.share_pct)}`} value={n.share_pct} onChange={(e) => setNom(n.uid, { share_pct: e.target.value })} placeholder="%" /></td>
                          <td className="px-1.5 py-1.5 min-w-[120px]"><input type="date" className={CELL} value={n.dob} onChange={(e) => setNom(n.uid, { dob: e.target.value })} /></td>
                          <td className="px-1.5 py-1.5 text-center"><input type="checkbox" checked={n.is_minor} onChange={(e) => setNom(n.uid, { is_minor: e.target.checked })} /></td>
                          <td className="px-1.5 py-1.5 min-w-[120px]"><input className={CELL} value={n.guardian_name} onChange={(e) => setNom(n.uid, { guardian_name: e.target.value })} disabled={!n.is_minor} placeholder={n.is_minor ? "Guardian name" : "—"} /></td>
                          <td className="px-1.5 py-1.5"><button type="button" onClick={() => setNominees((p) => p.filter((x) => x.uid !== n.uid))} className="text-slate-300 hover:text-red-600" aria-label="Remove nominee">✕</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <button type="button" onClick={() => setNominees((p) => [...p, blankNominee(employees.length === 1 ? employees[0].uid : null)])} className="text-xs font-semibold text-blue-600 hover:text-blue-800">+ Add nominee</button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between gap-3">
          <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 bg-white rounded-lg hover:bg-slate-50">Cancel</button>
          <div className="flex items-center gap-2">
            {tab !== "company" && <button type="button" onClick={() => setTab(order[order.indexOf(tab) - 1])} className="px-4 py-2 text-xs font-semibold text-slate-700 border border-slate-200 bg-white rounded-lg hover:bg-slate-50">Back</button>}
            {tab !== "nominees" ? (
              <button type="button" onClick={() => setTab(order[order.indexOf(tab) + 1])} className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">Next</button>
            ) : (
              <button type="button" onClick={submit} disabled={saving || extracting} className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 rounded-lg">
                {saving ? "Creating…" : "Create corporate & enrol"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
