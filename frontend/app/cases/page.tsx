"use client";

import { useState, useEffect } from "react";
import api from "@/app/services/api";

interface Applicant {
  id: string;
  cnic: string;
  name: string;
}

interface Case {
  caseld: string;
  caseNumber: string;
  applicant_id: string;
  caseType: string;
  caseStatus: string;
  priorityLevel: string;
  sourceChannel: string;
  createdAt: string;
  updatedAt: string;
  assignedAgentId?: string;
  escalationLevel: number;
}

const STATUS_STYLE: Record<string, string> = {
  Approved: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  "Under Review": "bg-blue-50 text-blue-700 border border-blue-200",
  "InProgress": "bg-blue-50 text-blue-700 border border-blue-200",
  "Pending Documents": "bg-amber-50 text-amber-700 border border-amber-200",
  "New": "bg-slate-100 text-slate-700 border border-slate-200",
  "Rejected": "bg-red-50 text-red-700 border border-red-200",
  "Closed": "bg-slate-200 text-slate-800 border border-slate-300",
};

const TYPE_STYLE: Record<string, string> = {
  Underwriting: "bg-blue-50 text-blue-700",
  Claim: "bg-violet-50 text-violet-700",
  Inquiry: "bg-emerald-50 text-emerald-700",
};

export default function CasesPage() {
  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});

  // Create Case Modal State
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedApplicantId, setSelectedApplicantId] = useState<string>("");
  const [newCaseType, setNewCaseType] = useState("Underwriting");
  const [newPriority, setNewPriority] = useState("Normal");
  const [newChannel, setNewChannel] = useState("Online");

  // View Case Modal State
  const [selectedCase, setSelectedCase] = useState<Case | null>(null);
  const [newStatus, setNewStatus] = useState("");
  const [editPriority, setEditPriority] = useState("");

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    setError("");
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) {
      setError("No active tenant found.");
      setLoading(false);
      return;
    }
    try {
      const [appRes, caseRes] = await Promise.all([
        api.get(`/tenants/${tenantId}/applicants`),
        api.get(`/tenants/${tenantId}/cases`),
      ]);
      setApplicants(appRes.data);
      setCases(caseRes.data);
      
      // Auto-expand all folders initially
      const expansions: Record<string, boolean> = {};
      appRes.data.forEach((app: Applicant) => {
        expansions[app.id] = true;
      });
      setExpandedFolders(expansions);
    } catch (err: any) {
      setError(err.message ?? "Failed to load data.");
    } finally {
      setLoading(false);
    }
  };

  const toggleFolder = (id: string) => {
    setExpandedFolders(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const handleCreateCase = async (e: React.FormEvent) => {
    e.preventDefault();
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId || !selectedApplicantId) return;

    try {
      await api.post(`/tenants/${tenantId}/cases`, {
        applicant_id: selectedApplicantId,
        caseType: newCaseType,
        priorityLevel: newPriority,
        sourceChannel: newChannel,
      });
      setShowCreateModal(false);
      fetchData(); // Refresh to show new case
    } catch (err: any) {
      alert(err.response?.data?.detail ?? "Failed to create case");
    }
  };

  const handleUpdateStatus = async () => {
    if (!selectedCase || !newStatus) return;
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;

    try {
      await api.patch(`/tenants/${tenantId}/cases/${selectedCase.caseld}/status`, {
        status: newStatus
      });
      setSelectedCase(null);
      fetchData(); // Refresh list
    } catch (err: any) {
      alert(err.response?.data?.detail ?? "Failed to update status");
    }
  };

  const handleDeleteFolder = async (e: React.MouseEvent, applicantId: string) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this folder and all its cases?")) return;
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    try {
      await api.delete(`/tenants/${tenantId}/applicants/${applicantId}`);
      fetchData();
    } catch (err: any) {
      alert("Failed to delete folder: " + (err.response?.data?.detail || err.message));
    }
  };

  const handleEditFolder = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.location.href = `/admin/applicants`;
  };

  const handleDeleteCase = async (e: React.MouseEvent, caseId: string) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this case?")) return;
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    try {
      await api.delete(`/tenants/${tenantId}/cases/${caseId}`);
      fetchData();
    } catch (err: any) {
      alert("Failed to delete case.");
    }
  };

  const handleEditCaseSubmit = async () => {
    if (!selectedCase || !editPriority) return;
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    try {
      await api.put(`/tenants/${tenantId}/cases/${selectedCase.caseld}`, {
        priorityLevel: editPriority
      });
      setSelectedCase(null);
      fetchData();
    } catch (err: any) {
      alert("Failed to update case.");
    }
  };

  const casesByApplicant = applicants.map(app => ({
    applicant: app,
    cases: cases.filter(c => c.applicant_id === app.id)
  }));

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full font-sans">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Underwriting Cases</h1>
        <p className="text-sm text-slate-500 mt-0.5">Manage case workflows organized by applicant folders.</p>
      </div>

      {error && <div className="p-4 bg-red-50 text-red-600 rounded-lg text-sm border border-red-200">{error}</div>}

      {loading ? (
        <div className="flex justify-center py-20 text-slate-400">Loading cases directory...</div>
      ) : casesByApplicant.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-500 shadow-sm">
          No applicants found in the system. Create an applicant first to manage their cases.
        </div>
      ) : (
        <div className="space-y-4">
          {casesByApplicant.map((folder) => {
            const isExpanded = expandedFolders[folder.applicant.id];
            return (
              <div key={folder.applicant.id} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden transition-all">
                {/* Folder Header */}
                <div
                  className="group px-5 py-4 bg-slate-50 border-b border-slate-100 flex items-center justify-between cursor-pointer hover:bg-slate-100 transition-colors"
                  onClick={() => toggleFolder(folder.applicant.id)}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xl">{isExpanded ? "📂" : "📁"}</span>
                    <div>
                      <h3 className="font-bold text-slate-800">{folder.applicant.name}</h3>
                      <p className="text-xs text-slate-500 font-mono mt-0.5">ID: {folder.applicant.id}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity mr-2">
                      <button onClick={handleEditFolder} className="px-3 py-1 bg-white border border-slate-200 text-slate-600 text-[10px] font-bold rounded hover:bg-slate-50 shadow-sm">Edit Folder</button>
                      <button onClick={(e) => handleDeleteFolder(e, folder.applicant.id)} className="px-3 py-1 bg-red-50 border border-red-200 text-red-600 text-[10px] font-bold rounded hover:bg-red-100 shadow-sm">Delete</button>
                    </div>
                    <span className="text-xs font-semibold text-slate-500 bg-slate-200/50 px-2.5 py-1 rounded-full">
                      {folder.cases.length} {folder.cases.length === 1 ? "Case" : "Cases"}
                    </span>
                    <svg className={`w-5 h-5 text-slate-400 transform transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>

                {/* Folder Body */}
                {isExpanded && (
                  <div className="p-5">
                    {folder.cases.length === 0 ? (
                      <div className="text-center py-8">
                        <p className="text-sm text-slate-400 mb-3">Folder is empty. No cases uploaded yet.</p>
                        <button
                          onClick={() => {
                            setSelectedApplicantId(folder.applicant.id);
                            setShowCreateModal(true);
                          }}
                          className="px-4 py-2 bg-blue-50 text-blue-600 rounded-lg text-xs font-bold hover:bg-blue-100 transition-colors border border-blue-200 shadow-sm"
                        >
                          + Create Initial Case
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        <div className="flex justify-end">
                          <button
                            onClick={() => {
                              setSelectedApplicantId(folder.applicant.id);
                              setShowCreateModal(true);
                            }}
                            className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 shadow-sm transition-all"
                          >
                            + Add Another Case
                          </button>
                        </div>
                        <div className="border border-slate-100 rounded-lg overflow-hidden">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="bg-slate-50 border-b border-slate-100 text-left text-xs text-slate-500 uppercase tracking-wider">
                                <th className="px-4 py-3 font-semibold">Case Number</th>
                                <th className="px-4 py-3 font-semibold">Type</th>
                                <th className="px-4 py-3 font-semibold">Priority</th>
                                <th className="px-4 py-3 font-semibold">Status</th>
                                <th className="px-4 py-3 font-semibold">Updated</th>
                                <th className="px-4 py-3 font-semibold text-right">Actions</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                              {folder.cases.map(c => (
                                <tr key={c.caseld} className="hover:bg-slate-50/50">
                                  <td className="px-4 py-3 font-mono text-xs font-semibold text-slate-700">{c.caseNumber}</td>
                                  <td className="px-4 py-3">
                                    <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-bold ${TYPE_STYLE[c.caseType] || "bg-slate-100 text-slate-700"}`}>{c.caseType}</span>
                                  </td>
                                  <td className="px-4 py-3">
                                    <span className={`text-[11px] font-bold ${c.priorityLevel === 'Critical' ? 'text-red-600' : c.priorityLevel === 'High' ? 'text-orange-600' : 'text-slate-500'}`}>{c.priorityLevel}</span>
                                  </td>
                                  <td className="px-4 py-3">
                                    <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-bold ${STATUS_STYLE[c.caseStatus] || "bg-slate-100 text-slate-700"}`}>{c.caseStatus}</span>
                                  </td>
                                  <td className="px-4 py-3 text-xs text-slate-500">
                                    {new Date(c.updatedAt).toLocaleDateString()}
                                  </td>
                                  <td className="px-4 py-3 text-right">
                                    <div className="flex justify-end gap-2">
                                      <button
                                        onClick={() => {
                                          setSelectedCase(c);
                                          setNewStatus(c.caseStatus);
                                          setEditPriority(c.priorityLevel);
                                        }}
                                        className="px-3 py-1 bg-white border border-slate-200 text-slate-600 text-xs font-semibold rounded hover:bg-slate-50 shadow-sm"
                                      >
                                        View/Edit
                                      </button>
                                      <button
                                        onClick={(e) => handleDeleteCase(e, c.caseld)}
                                        className="px-3 py-1 bg-red-50 border border-red-200 text-red-600 text-xs font-semibold rounded hover:bg-red-100 shadow-sm"
                                      >
                                        Delete
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* CREATE CASE MODAL */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
              <h3 className="font-bold text-slate-800">Generate New Case</h3>
              <button onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>
            <form onSubmit={handleCreateCase} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Case Type</label>
                <select value={newCaseType} onChange={e => setNewCaseType(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm">
                  <option value="Underwriting">Underwriting</option>
                  <option value="Claim">Claim</option>
                  <option value="Inquiry">Inquiry</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Priority Level</label>
                <select value={newPriority} onChange={e => setNewPriority(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm">
                  <option value="Low">Low</option>
                  <option value="Normal">Normal</option>
                  <option value="High">High</option>
                  <option value="Critical">Critical</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Source Channel</label>
                <select value={newChannel} onChange={e => setNewChannel(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm">
                  <option value="Online">Online</option>
                  <option value="Agent">Agent</option>
                  <option value="Branch">Branch</option>
                </select>
              </div>
              <div className="pt-4 flex justify-end gap-3">
                <button type="button" onClick={() => setShowCreateModal(false)} className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-lg border border-transparent">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 shadow-sm">Create Case</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MANAGE / VIEW CASE MODAL */}
      {selectedCase && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
              <div>
                <h3 className="font-bold text-slate-800">Case Details</h3>
                <p className="text-xs font-mono text-slate-500 mt-0.5">{selectedCase.caseNumber}</p>
              </div>
              <button onClick={() => setSelectedCase(null)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>
            <div className="p-6 space-y-6">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="block text-xs font-semibold text-slate-400 uppercase mb-0.5">Current Status</span>
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-bold ${STATUS_STYLE[selectedCase.caseStatus] || "bg-slate-100 text-slate-700"}`}>
                    {selectedCase.caseStatus}
                  </span>
                </div>
                <div>
                  <span className="block text-xs font-semibold text-slate-400 uppercase mb-0.5">Created At</span>
                  <span className="font-medium text-slate-700">{new Date(selectedCase.createdAt).toLocaleString()}</span>
                </div>
              </div>

              {/* Action Panel for Updating Case Properties */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-4">
                <h4 className="text-xs font-bold text-slate-800 uppercase">Edit Case Properties</h4>
                <div className="flex gap-3">
                  <select
                    value={editPriority}
                    onChange={e => setEditPriority(e.target.value)}
                    className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-700"
                  >
                    <option value="Low">Low Priority</option>
                    <option value="Normal">Normal Priority</option>
                    <option value="High">High Priority</option>
                    <option value="Critical">Critical Priority</option>
                  </select>
                  <button
                    onClick={handleEditCaseSubmit}
                    disabled={editPriority === selectedCase.priorityLevel}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 disabled:opacity-50 shadow-sm transition-all"
                  >
                    Save Changes
                  </button>
                </div>
                
                <hr className="border-slate-200" />
                
                <h4 className="text-xs font-bold text-slate-800 uppercase">Update Status</h4>
                <div className="flex gap-3">
                  <select
                    value={newStatus}
                    onChange={e => setNewStatus(e.target.value)}
                    className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-700"
                  >
                    <option value="New">New</option>
                    <option value="InProgress">In Progress</option>
                    <option value="Pending Documents">Pending Documents</option>
                    <option value="Under Review">Under Review</option>
                    <option value="Approved">Approved</option>
                    <option value="Rejected">Rejected</option>
                    <option value="Closed">Closed</option>
                  </select>
                  <button
                    onClick={handleUpdateStatus}
                    disabled={newStatus === selectedCase.caseStatus}
                    className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-xs font-bold hover:bg-emerald-700 disabled:opacity-50 disabled:hover:bg-emerald-600 shadow-sm transition-all"
                  >
                    Transition State
                  </button>
                </div>
                <p className="text-[10px] text-slate-400 mt-2">Note: Status changes automatically append an immutable record to the CaseHistory table.</p>
              </div>

            </div>
          </div>
        </div>
      )}
    </div>
  );
}
