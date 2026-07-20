"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { MetricCard } from "@/components/MetricCard";
import api from "@/app/services/api";

interface Organization {
  id: string;
  name: string;
  industry: string | null;
  created_at: string;
}

interface MasterPolicy {
  id: string;
  organization_id: string;
  status: string;
  sum_assured_multiple: number;
}

interface AccountRow {
  organization: Organization;
  employeeCount: number;
  masterPolicies: MasterPolicy[];
}

const STATUS_STYLE: Record<string, string> = {
  Active: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  Pending: "bg-blue-50 text-blue-700 border border-blue-200",
  Review: "bg-amber-50 text-amber-700 border border-amber-200",
};

export default function CorporatePage() {
  const router = useRouter();
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    setError("");
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) {
      setError("No active organization tenant found.");
      setLoading(false);
      return;
    }
    try {
      const orgsResp = await api.get<Organization[]>(`/tenants/${tenantId}/organizations`);
      const organizations = orgsResp.data;

      const details = await Promise.all(
        organizations.map(async (org) => {
          const [mpResp, empResp] = await Promise.all([
            api.get<MasterPolicy[]>(`/tenants/${tenantId}/organizations/${org.id}/master-policies`),
            api.get<{ id: string }[]>(`/tenants/${tenantId}/organizations/${org.id}/employees`),
          ]);
          return {
            organization: org,
            masterPolicies: mpResp.data,
            employeeCount: empResp.data.length,
          };
        })
      );
      setRows(details);
    } catch (err: any) {
      setError(err.message ?? "Failed to load corporate accounts.");
    } finally {
      setLoading(false);
    }
  };

  const totalEmployees = rows.reduce((sum, r) => sum + r.employeeCount, 0);
  const activeMasterPolicies = rows.reduce((sum, r) => sum + r.masterPolicies.filter((mp) => mp.status === "Active").length, 0);
  const pendingOrgs = rows.filter((r) => r.employeeCount === 0).length;

  const accountStatus = (row: AccountRow): string => {
    if (row.masterPolicies.some((mp) => mp.status === "Active")) return "Active";
    if (row.masterPolicies.length > 0) return "Pending";
    return "Review";
  };

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Corporate Underwriting</h1>
          <p className="text-sm text-slate-500 mt-0.5">Group life accounts for small &amp; medium businesses insuring their staff under a master policy.</p>
        </div>
        <div className="flex flex-col sm:flex-row items-center gap-3 w-full sm:w-auto">
          <input
            type="text"
            placeholder="Search by company or industry..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full sm:w-64 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
          />
          <button
            onClick={() => router.push("/admin/organizations")}
            className="flex items-center justify-center px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-all shadow-sm w-full sm:w-auto"
          >
            Manage Organizations
          </button>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600 font-medium">{error}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard title="Corporate Clients" value={rows.length} subtitle="registered organizations" accent="blue" />
        <MetricCard title="Total Employees" value={totalEmployees.toLocaleString()} subtitle="covered lives across all groups" accent="emerald" />
        <MetricCard title="Active Master Policies" value={activeMasterPolicies} subtitle="group life contracts in force" accent="amber" />
        <MetricCard title="Pending Enrollment" value={pendingOrgs} subtitle="organizations awaiting a census" accent="red" />
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-700">
        Premium pricing, commission calculation, claims-ratio, and fraud scoring for group accounts are not yet built — this dashboard shows only what the platform actually tracks today (organizations, employee census, and master policy status).
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-700">Corporate Accounts</p>
        </div>

        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center gap-2">
            <div className="animate-spin h-7 w-7 text-blue-500 rounded-full border-2 border-slate-100 border-t-blue-500" />
            <span className="text-xs text-slate-400">Loading corporate accounts...</span>
          </div>
        ) : rows.length === 0 ? (
          <div className="py-20 text-center text-slate-400">
            <p className="text-sm">No corporate accounts yet.</p>
            <button onClick={() => router.push("/admin/organizations")} className="mt-3 text-xs text-blue-600 font-semibold hover:underline">
              Add the first organization
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-5 py-3 text-left">Company</th>
                  <th className="px-5 py-3 text-left">Industry</th>
                  <th className="px-5 py-3 text-right">Employees</th>
                  <th className="px-5 py-3 text-right">Master Policies</th>
                  <th className="px-5 py-3 text-left">Status</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows
                  .filter((row) => {
                    const q = search.trim().toLowerCase();
                    if (!q) return true;
                    return (
                      row.organization.name.toLowerCase().includes(q) ||
                      (row.organization.industry || "").toLowerCase().includes(q)
                    );
                  })
                  .map((row) => {
                  const status = accountStatus(row);
                  return (
                    <tr key={row.organization.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-5 py-3 font-medium text-slate-800">{row.organization.name}</td>
                      <td className="px-5 py-3 text-slate-600">{row.organization.industry ?? "—"}</td>
                      <td className="px-5 py-3 text-right text-slate-600">{row.employeeCount.toLocaleString()}</td>
                      <td className="px-5 py-3 text-right text-slate-600">{row.masterPolicies.length}</td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLE[status]}`}>{status}</span>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <button
                          onClick={() => router.push(`/admin/organizations/${row.organization.id}`)}
                          className="text-xs font-bold text-blue-600 hover:text-blue-800 transition-colors"
                        >
                          Manage →
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
