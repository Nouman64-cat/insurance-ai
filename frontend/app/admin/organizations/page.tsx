"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import api from "@/app/services/api";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";

const organizationSchema = z.object({
  name: z.string().min(2, "Company name must be at least 2 characters"),
  registrationNumber: z.string().optional(),
  industry: z.string().optional(),
  contactPerson: z.string().optional(),
  contactEmail: z.union([z.literal(""), z.string().email("Invalid email format")]).optional(),
  contactPhone: z.string().optional(),
});

interface Organization {
  id: string;
  tenant_id: string;
  name: string;
  registration_number: string | null;
  industry: string | null;
  contact_person: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  created_at: string;
}

export default function OrganizationsPage() {
  const router = useRouter();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null);
  const [formLoading, setFormLoading] = useState(false);

  const { register, handleSubmit: hookFormSubmit, reset, formState: { errors } } = useForm<z.infer<typeof organizationSchema>>({
    resolver: zodResolver(organizationSchema),
    mode: "onChange",
    defaultValues: { name: "", registrationNumber: "", industry: "", contactPerson: "", contactEmail: "", contactPhone: "" }
  });

  const editForm = useForm<z.infer<typeof organizationSchema>>({
    resolver: zodResolver(organizationSchema),
    mode: "onChange",
    defaultValues: { name: "", registrationNumber: "", industry: "", contactPerson: "", contactEmail: "", contactPhone: "" }
  });

  useEffect(() => {
    const role = localStorage.getItem("user_role");
    if (role !== "Admin") {
      setAuthorized(false);
      setLoading(false);
      return;
    }
    fetchOrganizations();
  }, []);

  const fetchOrganizations = async () => {
    setLoading(true);
    setError("");
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) {
      setError("No active organization tenant found.");
      setLoading(false);
      return;
    }
    try {
      const resp = await api.get<Organization[]>(`/tenants/${tenantId}/organizations`);
      setOrganizations(resp.data);
    } catch (err: any) {
      setError(err.message ?? "Failed to load organizations.");
    } finally {
      setLoading(false);
    }
  };

  const handleOpenCreateModal = () => {
    reset();
    setError("");
    setSuccess("");
    setShowCreateModal(true);
  };

  const handleOpenEditModal = (org: Organization) => {
    setSelectedOrg(org);
    editForm.reset({
      name: org.name,
      registrationNumber: org.registration_number || "",
      industry: org.industry || "",
      contactPerson: org.contact_person || "",
      contactEmail: org.contact_email || "",
      contactPhone: org.contact_phone || "",
    });
    setError("");
    setSuccess("");
    setShowEditModal(true);
  };

  const handleEditOrganization = async (data: z.infer<typeof organizationSchema>) => {
    if (!selectedOrg) return;
    setError("");
    setSuccess("");
    setFormLoading(true);
    const tenantId = localStorage.getItem("tenant_id");

    try {
      await api.patch(`/tenants/${tenantId}/organizations/${selectedOrg.id}`, {
        name: data.name,
        registration_number: data.registrationNumber || null,
        industry: data.industry || null,
        contact_person: data.contactPerson || null,
        contact_email: data.contactEmail || null,
        contact_phone: data.contactPhone || null,
      });
      setSuccess(`Organization "${data.name}" updated successfully!`);
      setShowEditModal(false);
      fetchOrganizations();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to update organization.");
    } finally {
      setFormLoading(false);
    }
  };

  const handleDeleteOrganization = async (org: Organization) => {
    if (!confirm(`Are you sure you want to delete the organization "${org.name}"?`)) {
      return;
    }
    setError("");
    setSuccess("");
    const tenantId = localStorage.getItem("tenant_id");

    try {
      await api.delete(`/tenants/${tenantId}/organizations/${org.id}`);
      setSuccess("Organization deleted successfully!");
      fetchOrganizations();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to delete organization.");
    }
  };

  const handleCreateOrganization = async (data: z.infer<typeof organizationSchema>) => {
    setError("");
    setSuccess("");
    setFormLoading(true);
    const tenantId = localStorage.getItem("tenant_id");

    try {
      await api.post(`/tenants/${tenantId}/organizations`, {
        name: data.name,
        registration_number: data.registrationNumber || null,
        industry: data.industry || null,
        contact_person: data.contactPerson || null,
        contact_email: data.contactEmail || null,
        contact_phone: data.contactPhone || null,
      });
      setSuccess(`Organization "${data.name}" created successfully!`);
      setShowCreateModal(false);
      fetchOrganizations();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to create organization.");
    } finally {
      setFormLoading(false);
    }
  };

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
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Organization Management</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Businesses insuring their staff under a group policy, rather than individuals shopping for their own coverage.
          </p>
        </div>
        <button
          onClick={handleOpenCreateModal}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-all shadow-sm hover:shadow active:scale-95 self-start"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor" className="w-4 h-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add Organization
        </button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600 font-medium">{error}</div>}
      {success && <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm text-emerald-600 font-medium">{success}</div>}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-700">Registered Organizations</p>
          <span className="text-xs text-slate-400 font-medium">Total: {organizations.length}</span>
        </div>

        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center gap-2">
            <div className="animate-spin h-7 w-7 text-blue-500 rounded-full border-2 border-slate-100 border-t-blue-500" />
            <span className="text-xs text-slate-400">Loading organizations...</span>
          </div>
        ) : organizations.length === 0 ? (
          <div className="py-20 text-center text-slate-400">
            <p className="text-sm">No organizations registered in this tenant.</p>
            <button onClick={handleOpenCreateModal} className="mt-3 text-xs text-blue-600 font-semibold hover:underline">
              Add the first organization
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-5 py-3.5 text-left">Company Name</th>
                  <th className="px-5 py-3.5 text-left">Industry</th>
                  <th className="px-5 py-3.5 text-left">Contact Person</th>
                  <th className="px-5 py-3.5 text-left">Contact Email</th>
                  <th className="px-5 py-3.5 text-left">Created</th>
                  <th className="px-5 py-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {organizations.map((org) => (
                  <tr key={org.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3.5 font-semibold text-slate-800">{org.name}</td>
                    <td className="px-5 py-3.5 text-slate-600">{org.industry ?? "—"}</td>
                    <td className="px-5 py-3.5 text-slate-600">{org.contact_person ?? "—"}</td>
                    <td className="px-5 py-3.5 text-slate-600">{org.contact_email ?? "—"}</td>
                    <td className="px-5 py-3.5 text-xs text-slate-400">
                      {new Date(org.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                    </td>
                    <td className="px-5 py-3.5 text-right space-x-2 whitespace-nowrap">
                      <button
                        onClick={() => router.push(`/admin/organizations/${org.id}`)}
                        className="text-xs font-bold text-emerald-600 hover:text-emerald-800 transition-colors"
                      >
                        View
                      </button>
                      <span className="text-slate-200">|</span>
                      <button
                        onClick={() => handleOpenEditModal(org)}
                        className="text-xs font-bold text-blue-600 hover:text-blue-800 transition-colors"
                      >
                        Edit
                      </button>
                      <span className="text-slate-200">|</span>
                      <button
                        onClick={() => handleDeleteOrganization(org)}
                        className="text-xs font-bold text-red-500 hover:text-red-700 transition-colors"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── CREATE ORGANIZATION MODAL ── */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-lg w-full p-6 space-y-4 my-8">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">Add New Organization</h3>
              <button onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-slate-600 transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={hookFormSubmit(handleCreateOrganization)} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Company Name *</label>
                <input
                  type="text"
                  {...register("name")}
                  placeholder="e.g. TechPak Solutions"
                  className={`w-full bg-slate-50 border ${errors.name ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                />
                {errors.name && <span className="text-[10px] text-red-500">{errors.name.message}</span>}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Registration No. (NTN)</label>
                  <input
                    type="text"
                    {...register("registrationNumber")}
                    placeholder="e.g. 1234567-8"
                    className={`w-full bg-slate-50 border ${errors.registrationNumber ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                  />
                  {errors.registrationNumber && <span className="text-[10px] text-red-500">{errors.registrationNumber.message}</span>}
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Industry</label>
                  <input
                    type="text"
                    {...register("industry")}
                    placeholder="e.g. Textiles"
                    className={`w-full bg-slate-50 border ${errors.industry ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                  />
                  {errors.industry && <span className="text-[10px] text-red-500">{errors.industry.message}</span>}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Contact Person</label>
                <input
                  type="text"
                  {...register("contactPerson", { onChange: (e) => e.target.value = e.target.value.replace(/[^A-Za-z\s]/g, '') })}
                  placeholder="e.g. Ali Raza (HR Manager)"
                  className={`w-full bg-slate-50 border ${errors.contactPerson ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                />
                {errors.contactPerson && <span className="text-[10px] text-red-500">{errors.contactPerson.message}</span>}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Contact Email</label>
                  <input
                    type="email"
                    {...register("contactEmail")}
                    placeholder="hr@company.com"
                    className={`w-full bg-slate-50 border ${errors.contactEmail ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                  />
                  {errors.contactEmail && <span className="text-[10px] text-red-500">{errors.contactEmail.message}</span>}
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Contact Phone</label>
                  <input
                    type="text"
                    {...register("contactPhone")}
                    placeholder="+92 300 1234567"
                    className={`w-full bg-slate-50 border ${errors.contactPhone ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                  />
                  {errors.contactPhone && <span className="text-[10px] text-red-500">{errors.contactPhone.message}</span>}
                </div>
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
                  Create Organization
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── EDIT ORGANIZATION MODAL ── */}
      {showEditModal && selectedOrg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-lg w-full p-6 space-y-4 my-8">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">Edit Organization</h3>
              <button onClick={() => setShowEditModal(false)} className="text-slate-400 hover:text-slate-600 transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={editForm.handleSubmit(handleEditOrganization)} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Company Name *</label>
                <input
                  type="text"
                  {...editForm.register("name")}
                  className={`w-full bg-slate-50 border ${editForm.formState.errors.name ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                />
                {editForm.formState.errors.name && <span className="text-[10px] text-red-500">{editForm.formState.errors.name.message}</span>}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Registration No. (NTN)</label>
                  <input
                    type="text"
                    {...editForm.register("registrationNumber")}
                    className={`w-full bg-slate-50 border ${editForm.formState.errors.registrationNumber ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Industry</label>
                  <input
                    type="text"
                    {...editForm.register("industry")}
                    className={`w-full bg-slate-50 border ${editForm.formState.errors.industry ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Contact Person</label>
                <input
                  type="text"
                  {...editForm.register("contactPerson", { onChange: (e) => e.target.value = e.target.value.replace(/[^A-Za-z\s]/g, '') })}
                  className={`w-full bg-slate-50 border ${editForm.formState.errors.contactPerson ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Contact Email</label>
                  <input
                    type="email"
                    {...editForm.register("contactEmail")}
                    className={`w-full bg-slate-50 border ${editForm.formState.errors.contactEmail ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                  />
                  {editForm.formState.errors.contactEmail && <span className="text-[10px] text-red-500">{editForm.formState.errors.contactEmail.message}</span>}
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Contact Phone</label>
                  <input
                    type="text"
                    {...editForm.register("contactPhone")}
                    className={`w-full bg-slate-50 border ${editForm.formState.errors.contactPhone ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button" onClick={() => setShowEditModal(false)}
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
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
