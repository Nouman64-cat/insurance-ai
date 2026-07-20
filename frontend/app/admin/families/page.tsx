"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import api from "@/app/services/api";
import { fetchFamilyStats, listFamilies, FamilyStats, FamilyCategory } from "@/app/services/families";

interface FamilyGroup {
  id: string;
  tenant_id: string;
  name: string;
  contact_person: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  household_declared_income: number | null;
  primary_member_customer_id: string | null;
  created_at: string;
  member_count: number;
  family_policy_status: string | null;
}

function formatPKR(n: number): string {
  return `PKR ${Math.round(n).toLocaleString()}`;
}

const CATEGORY_META: Record<FamilyCategory, {
  label: string;
  description: string;
  accent: string;
  headerBg: string;
  dot: string;
  badgeBg: string;
  badgeText: string;
  emptyHint: string;
}> = {
  active: {
    label: "Active Policy",
    description: "Floater or life-bundle policy running",
    accent: "text-emerald-700 border-emerald-200",
    headerBg: "bg-white border-t-[4px] border-t-emerald-500",
    dot: "bg-emerald-500",
    badgeBg: "bg-emerald-50",
    badgeText: "text-emerald-700",
    emptyHint: "No families with an active policy yet.",
  },
  in_progress: {
    label: "Setup In Progress",
    description: "Members added and/or a policy pending confirmation",
    accent: "text-blue-700 border-blue-200",
    headerBg: "bg-white border-t-[4px] border-t-blue-600",
    dot: "bg-blue-500",
    badgeBg: "bg-blue-50",
    badgeText: "text-blue-700",
    emptyHint: "No families mid-setup right now.",
  },
  new: {
    label: "New / No Members Yet",
    description: "Household created, no members added",
    accent: "text-amber-700 border-amber-200",
    headerBg: "bg-white border-t-[4px] border-t-amber-400",
    dot: "bg-amber-500",
    badgeBg: "bg-amber-50",
    badgeText: "text-amber-700",
    emptyHint: "No new households waiting on members.",
  },
};

const CATEGORY_ORDER: FamilyCategory[] = ["active", "in_progress", "new"];

export default function FamiliesPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [stats, setStats] = useState<FamilyStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
  const [board, setBoard] = useState<Record<FamilyCategory, FamilyGroup[]>>({
    active: [],
    in_progress: [],
    new: [],
  });
  const [allFamilies, setAllFamilies] = useState<FamilyGroup[]>([]);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showQuickModal, setShowQuickModal] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const [editingFamId, setEditingFamId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [householdIncome, setHouseholdIncome] = useState("");

  // Quick Add modal state
  const [quickName, setQuickName] = useState("");
  const [quickContactPerson, setQuickContactPerson] = useState("");
  const [quickContactPhone, setQuickContactPhone] = useState("");
  const [quickSaving, setQuickSaving] = useState(false);

  useEffect(() => {
    const role = localStorage.getItem("user_role");
    if (role !== "Admin") {
      setAuthorized(false);
      setLoading(false);
      return;
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    if (!authorized) return;
    fetchFamilies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized, debouncedSearch]);

  const fetchStats = async (tenantId: string) => {
    setStatsLoading(true);
    try {
      setStats(await fetchFamilyStats(tenantId));
    } catch {
      setStats(null);
    } finally {
      setStatsLoading(false);
    }
  };

  const fetchFamilies = async () => {
    setLoading(true);
    setError("");
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) {
      setError("No active organization tenant found.");
      setLoading(false);
      return;
    }
    try {
      const params = { search: debouncedSearch };
      const [active, inProgress, fresh] = await Promise.all([
        listFamilies<FamilyGroup>(tenantId, { ...params, category: "active" }),
        listFamilies<FamilyGroup>(tenantId, { ...params, category: "in_progress" }),
        listFamilies<FamilyGroup>(tenantId, { ...params, category: "new" }),
      ]);
      setBoard({ active, in_progress: inProgress, new: fresh });
      setAllFamilies([...active, ...inProgress, ...fresh]);
      fetchStats(tenantId);
    } catch (err: any) {
      setError(err.message ?? "Failed to load family groups.");
    } finally {
      setLoading(false);
    }
  };

  const handleOpenCreateModal = (fam?: FamilyGroup) => {
    if (fam) {
      setEditingFamId(fam.id);
      setName(fam.name);
      setContactPerson(fam.contact_person || "");
      setContactEmail(fam.contact_email || "");
      setContactPhone(fam.contact_phone || "");
      setHouseholdIncome(fam.household_declared_income?.toString() || "");
    } else {
      setEditingFamId(null);
      setName("");
      setContactPerson("");
      setContactEmail("");
      setContactPhone("");
      setHouseholdIncome("");
    }
    setError("");
    setSuccess("");
    setShowCreateModal(true);
  };

  const handleSubmitFamily = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setFormLoading(true);
    const tenantId = localStorage.getItem("tenant_id");

    try {
      const payload = {
        name,
        contact_person: contactPerson || null,
        contact_email: contactEmail || null,
        contact_phone: contactPhone || null,
        household_declared_income: householdIncome ? parseFloat(householdIncome) : null,
      };

      if (editingFamId) {
        await api.patch(`/tenants/${tenantId}/families/${editingFamId}`, payload);
        setSuccess(`Family "${name}" updated successfully!`);
      } else {
        await api.post(`/tenants/${tenantId}/families`, payload);
        setSuccess(`Family "${name}" created successfully!`);
      }
      setShowCreateModal(false);
      fetchFamilies();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to save family group.");
    } finally {
      setFormLoading(false);
    }
  };

  const handleCreateQuickFamily = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickName.trim()) {
      setError("Family name is required.");
      return;
    }
    setQuickSaving(true);
    setError("");
    setSuccess("");
    const tenantId = localStorage.getItem("tenant_id");
    try {
      await api.post(`/tenants/${tenantId}/families`, {
        name: quickName.trim(),
        contact_person: quickContactPerson.trim() || null,
        contact_phone: quickContactPhone.trim() || null,
      });
      setSuccess(`Family "${quickName.trim()}" added — add members and a policy when ready.`);
      setShowQuickModal(false);
      setQuickName("");
      setQuickContactPerson("");
      setQuickContactPhone("");
      fetchFamilies();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to add family.");
    } finally {
      setQuickSaving(false);
    }
  };

  const handleDeleteFamily = async (famId: string, famName: string) => {
    if (!confirm(`Are you sure you want to delete the family "${famName}"? This action cannot be undone.`)) {
      return;
    }
    setError("");
    setSuccess("");
    const tenantId = localStorage.getItem("tenant_id");
    try {
      await api.delete(`/tenants/${tenantId}/families/${famId}`);
      setSuccess(`Family "${famName}" deleted successfully!`);
      fetchFamilies();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to delete family group.");
    }
  };

  const statusBadge = (status: string | null) => {
    if (status === "Active") {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
          Active
        </span>
      );
    }
    if (status) {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
          {status}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
        No Policy Yet
      </span>
    );
  };

  const renderStatTile = (label: string, value: number | undefined, accentColor: string, textColor: string) => (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
      <div className={`h-1 ${accentColor}`} />
      <div className="p-4 sm:p-5">
        <div className="text-[10px] sm:text-xs font-semibold uppercase tracking-widest text-slate-400">{label}</div>
        <div className={`text-2xl sm:text-4xl font-extrabold tracking-tight mt-1 sm:mt-2 ${textColor}`}>
          {statsLoading || value === undefined ? (
            <span className="inline-block w-10 h-8 bg-current/10 rounded animate-pulse" />
          ) : (
            value.toLocaleString()
          )}
        </div>
      </div>
    </div>
  );

  const renderFamilyCard = (fam: FamilyGroup) => (
    <div
      key={fam.id}
      className="bg-white rounded-lg border border-slate-200 shadow-sm hover:shadow-md hover:border-slate-300 transition-all p-3.5 space-y-2.5"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold text-slate-800 text-sm truncate">{fam.name}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">{fam.contact_person || "No contact person specified"}</div>
        </div>
        {statusBadge(fam.family_policy_status)}
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
        {fam.contact_phone && <span>📞 {fam.contact_phone}</span>}
        {fam.household_declared_income != null && <span>{formatPKR(fam.household_declared_income)}/yr</span>}
      </div>

      <div className="text-xs font-semibold text-slate-700">
        {fam.member_count} member{fam.member_count === 1 ? "" : "s"}
      </div>

      <div className="flex items-center justify-between gap-1.5 pt-1.5 border-t border-slate-100">
        <div className="flex gap-1">
          <button
            onClick={() => router.push(`/admin/families/${fam.id}`)}
            className="px-2 py-1 text-[11px] font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
          >
            Manage
          </button>
          <button
            onClick={() => handleOpenCreateModal(fam)}
            className="px-2 py-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-md transition-colors"
          >
            Edit
          </button>
        </div>
        <button
          onClick={() => handleDeleteFamily(fam.id, fam.name)}
          className="px-2 py-1 text-[11px] font-semibold text-red-600 bg-white hover:bg-red-50 border border-red-100 rounded-md transition-colors"
        >
          Delete
        </button>
      </div>
    </div>
  );

  if (!authorized) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] font-sans">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-md w-full p-8 text-center space-y-4">
          <div className="text-red-500 font-bold">Unauthorized Access</div>
          <p className="text-slate-400 text-sm">Administrative privileges required.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full font-sans">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Family Management</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Households insured under a shared health floater and/or bundled individual life policies for their members.
          </p>
        </div>
        <div className="flex items-center gap-2 self-start">
          <button
            onClick={() => setShowQuickModal(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-300 rounded-lg hover:bg-emerald-100 transition-all shadow-sm active:scale-95"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-emerald-600">
              <path d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Quick Family
          </button>
          <button
            onClick={() => handleOpenCreateModal()}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-rose-600 rounded-lg hover:bg-rose-700 transition-all shadow-sm hover:shadow active:scale-95"
          >
            Full Family Entry
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {renderStatTile("Total Families", stats?.total_families, "bg-slate-400", "text-slate-700")}
        {renderStatTile("Active Policy", stats?.active, "bg-emerald-500", "text-emerald-700")}
        {renderStatTile("Setup In Progress", stats?.in_progress, "bg-blue-600", "text-blue-700")}
        {renderStatTile("New / No Members Yet", stats?.new_no_members, "bg-amber-400", "text-amber-700")}
      </div>

      {/* Search & view toggle */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by family name or contact person..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-shadow"
          />
        </div>
        <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden shrink-0">
          <button
            onClick={() => setViewMode("cards")}
            className={`px-3 py-2 text-xs font-semibold transition-colors ${viewMode === "cards" ? "bg-blue-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
          >
            Cards
          </button>
          <button
            onClick={() => setViewMode("table")}
            className={`px-3 py-2 text-xs font-semibold transition-colors border-l border-slate-200 ${viewMode === "table" ? "bg-blue-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
          >
            Table
          </button>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600 font-medium">{error}</div>}
      {success && <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm text-emerald-600 font-medium">{success}</div>}

      {/* Card board */}
      {viewMode === "cards" && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {CATEGORY_ORDER.map((cat) => {
            const meta = CATEGORY_META[cat];
            const list = board[cat];
            return (
              <div key={cat} className="flex flex-col bg-slate-50/60 rounded-xl border border-slate-200 overflow-hidden">
                <div className={`px-3.5 py-3 border-b ${meta.headerBg} flex items-center justify-between shrink-0`}>
                  <div>
                    <div className={`text-sm font-bold ${meta.accent.split(' ')[0]}`}>{meta.label}</div>
                    <div className="text-[10px] font-normal opacity-70 mt-0.5 text-slate-500">{meta.description}</div>
                  </div>
                  <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded-full bg-white text-xs font-bold border border-slate-200">
                    {loading ? "…" : list.length}
                  </span>
                </div>
                <div className="flex-1 overflow-y-auto max-h-[calc(100vh-360px)] min-h-[160px] p-2.5 space-y-2.5">
                  {loading ? (
                    <div className="py-10 text-center text-xs text-slate-400">Loading…</div>
                  ) : list.length === 0 ? (
                    <div className="py-10 text-center text-xs text-slate-400 px-3">{meta.emptyHint}</div>
                  ) : (
                    list.map((fam) => renderFamilyCard(fam))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Table view */}
      {viewMode === "table" && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          {loading ? (
            <div className="py-20 flex flex-col items-center justify-center gap-2">
              <div className="animate-spin h-7 w-7 text-blue-500 rounded-full border-2 border-slate-100 border-t-blue-500" />
              <span className="text-xs text-slate-400">Loading families...</span>
            </div>
          ) : allFamilies.length === 0 ? (
            <div className="py-20 text-center text-slate-400">
              <p className="text-sm">No family groups match the current search.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                    <th className="px-5 py-3.5 text-left">Family Name</th>
                    <th className="px-5 py-3.5 text-left">Contact Person</th>
                    <th className="px-5 py-3.5 text-center">Members</th>
                    <th className="px-5 py-3.5 text-right">Household Income</th>
                    <th className="px-5 py-3.5 text-center">Status</th>
                    <th className="px-5 py-3.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {allFamilies.map((fam) => (
                    <tr key={fam.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-5 py-3.5 font-semibold text-slate-800">{fam.name}</td>
                      <td className="px-5 py-3.5 text-slate-600">{fam.contact_person ?? "—"}</td>
                      <td className="px-5 py-3.5 text-center">
                        <span className={"font-bold " + (fam.member_count === 0 ? "text-amber-500" : "text-slate-800")}>
                          {fam.member_count}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-right text-slate-600">
                        {fam.household_declared_income != null ? formatPKR(fam.household_declared_income) : "—"}
                      </td>
                      <td className="px-5 py-3.5 text-center">{statusBadge(fam.family_policy_status)}</td>
                      <td className="px-5 py-3.5 text-right space-x-3">
                        <button
                          onClick={() => handleOpenCreateModal(fam)}
                          className="text-xs font-bold text-emerald-600 hover:text-emerald-800 transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteFamily(fam.id, fam.name)}
                          className="text-xs font-bold text-red-600 hover:text-red-800 transition-colors"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => router.push(`/admin/families/${fam.id}`)}
                          className="text-xs font-bold text-blue-600 hover:text-blue-800 transition-colors"
                        >
                          Manage →
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── QUICK ADD FAMILY MODAL ── */}
      {showQuickModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-sm w-full p-6 space-y-4 my-8">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">Quick Family</h3>
              <button onClick={() => setShowQuickModal(false)} className="text-slate-400 hover:text-slate-600 transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <form onSubmit={handleCreateQuickFamily} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Family Name *</label>
                <input
                  type="text" required value={quickName} onChange={(e) => setQuickName(e.target.value)}
                  placeholder="e.g. Rehman Family"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Contact Person (Proposer)</label>
                <input
                  type="text" value={quickContactPerson} onChange={(e) => setQuickContactPerson(e.target.value)}
                  placeholder="e.g. Asad Rehman"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Contact Phone</label>
                <input
                  type="text" value={quickContactPhone} onChange={(e) => setQuickContactPhone(e.target.value)}
                  placeholder="+92 300 1234567"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                />
              </div>
              <p className="text-[11px] text-slate-400">
                Adds the household now — add members, household income, and a policy later via "Full Family Entry" or the Manage page.
              </p>
              <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button" onClick={() => setShowQuickModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit" disabled={quickSaving}
                  className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-600/50 rounded-lg transition-colors"
                >
                  {quickSaving ? "Saving…" : "Add Family"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── CREATE / EDIT FAMILY MODAL ── */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-lg w-full p-6 space-y-4 my-8">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">{editingFamId ? "Edit Family" : "Add New Family"}</h3>
              <button onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-slate-600 transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleSubmitFamily} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Family Name *</label>
                <input
                  type="text" required value={name} onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Rehman Family"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Contact Person (Proposer)</label>
                <input
                  type="text" value={contactPerson} onChange={(e) => setContactPerson(e.target.value)}
                  placeholder="e.g. Asad Rehman"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Contact Email</label>
                  <input
                    type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)}
                    placeholder="family@example.com"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Contact Phone</label>
                  <input
                    type="text" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)}
                    placeholder="+92 300 1234567"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Household Annual Income (PKR)</label>
                <input
                  type="number" value={householdIncome} onChange={(e) => setHouseholdIncome(e.target.value)}
                  placeholder="2400000"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                />
                <p className="text-[11px] text-slate-400">
                  Used for the floater's income-eligibility check — children and non-earning members don't have their own income.
                </p>
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button" onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit" disabled={formLoading}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 rounded-lg transition-colors flex items-center gap-1.5"
                >
                  {formLoading && (
                    <svg className="animate-spin h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  )}
                  {editingFamId ? "Update Family" : "Create Family"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
