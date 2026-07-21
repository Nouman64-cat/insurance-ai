"use client";

import React, { useEffect, useState } from "react";
import api from "@/app/services/api";

type EntityType = "INDIVIDUAL" | "FAMILY" | "CORPORATE";

interface UnifiedDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  entityId: string;
  entityType: EntityType;
}

export default function UnifiedDetailsModal({ isOpen, onClose, entityId, entityType }: UnifiedDetailsModalProps) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (isOpen && entityId) {
      fetchDetails();
    }
  }, [isOpen, entityId]);

  const fetchDetails = async () => {
    setLoading(true);
    setError("");
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) {
      setError("No active tenant found.");
      setLoading(false);
      return;
    }

    try {
      let endpoint = "";
      if (entityType === "INDIVIDUAL") endpoint = `/tenants/${tenantId}/customers/${entityId}`;
      else if (entityType === "FAMILY") endpoint = `/tenants/${tenantId}/families/${entityId}`;
      else if (entityType === "CORPORATE") endpoint = `/tenants/${tenantId}/organizations/${entityId}`;

      const res = await api.get(endpoint);
      setData(res.data);
    } catch (err: any) {
      setError(err.message || "Failed to load details.");
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-5xl max-h-[90vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-slate-200 animate-in zoom-in-95 duration-300">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/50">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${
              entityType === 'INDIVIDUAL' ? 'bg-blue-100 text-blue-600' :
              entityType === 'FAMILY' ? 'bg-purple-100 text-purple-600' :
              'bg-emerald-100 text-emerald-600'
            }`}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
                {entityType === 'INDIVIDUAL' ? <><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></> : null}
                {entityType === 'FAMILY' ? <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></> : null}
                {entityType === 'CORPORATE' ? <><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><path d="M9 9h6"/><path d="M9 13h6"/><path d="M9 17h6"/></> : null}
              </svg>
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-800 tracking-tight">
                {loading ? "Loading..." : data?.name || "Unknown Profile"}
              </h2>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${
                  entityType === 'INDIVIDUAL' ? 'bg-blue-50 text-blue-700 border-blue-200' :
                  entityType === 'FAMILY' ? 'bg-purple-50 text-purple-700 border-purple-200' :
                  'bg-emerald-50 text-emerald-700 border-emerald-200'
                }`}>
                  {entityType}
                </span>
                {!loading && data?.profile_status && (
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                    {data.profile_status.replace('_', ' ')}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={() => {
                if (entityType === "INDIVIDUAL") window.location.href = `/admin/customers?id=${entityId}`;
                if (entityType === "FAMILY") window.location.href = `/admin/families?id=${entityId}`;
                if (entityType === "CORPORATE") window.location.href = `/admin/organizations?id=${entityId}`;
              }}
              className="text-xs font-semibold text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 px-4 py-2 rounded-lg transition-colors shadow-sm"
            >
              Open Full Legacy Editor
            </button>
            <button 
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-xl transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 bg-slate-50">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-64 gap-4">
              <div className="w-10 h-10 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
              <p className="text-sm font-medium text-slate-500">Retrieving profile data...</p>
            </div>
          ) : error ? (
            <div className="p-6 bg-red-50 text-red-600 rounded-xl border border-red-200 font-medium">
              {error}
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              
              {/* Left Column: Essential Info */}
              <div className="lg:col-span-1 space-y-6">
                
                {/* Profile Card */}
                <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">Contact & Identification</h3>
                  
                  <div className="space-y-4">
                    {entityType === 'INDIVIDUAL' && (
                      <>
                        <div>
                          <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">CNIC</p>
                          <p className="text-sm font-medium text-slate-800 font-mono mt-0.5">{data.cnic || "Not provided"}</p>
                        </div>
                        <div>
                          <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Phone</p>
                          <p className="text-sm font-medium text-slate-800 mt-0.5">{data.details?.phone || "Not provided"}</p>
                        </div>
                        <div>
                          <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Email</p>
                          <p className="text-sm font-medium text-slate-800 mt-0.5">{data.details?.email || "Not provided"}</p>
                        </div>
                        <div>
                          <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Date of Birth</p>
                          <p className="text-sm font-medium text-slate-800 mt-0.5">{data.date_of_birth ? new Date(data.date_of_birth).toLocaleDateString() : "Not provided"}</p>
                        </div>
                      </>
                    )}

                    {entityType === 'FAMILY' && (
                      <>
                        <div>
                          <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Primary Contact Phone</p>
                          <p className="text-sm font-medium text-slate-800 mt-0.5">{data.contact_phone || "Not provided"}</p>
                        </div>
                        <div>
                          <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Primary Contact Email</p>
                          <p className="text-sm font-medium text-slate-800 mt-0.5">{data.contact_email || "Not provided"}</p>
                        </div>
                        <div>
                          <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Head of Family ID</p>
                          <p className="text-sm font-medium text-slate-800 font-mono mt-0.5">{data.head_of_family_customer_id || "None assigned"}</p>
                        </div>
                      </>
                    )}

                    {entityType === 'CORPORATE' && (
                      <>
                        <div>
                          <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Registration Number</p>
                          <p className="text-sm font-medium text-slate-800 font-mono mt-0.5">{data.registration_number || "Not provided"}</p>
                        </div>
                        <div>
                          <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Industry</p>
                          <p className="text-sm font-medium text-slate-800 mt-0.5">{data.industry_type || "Not specified"}</p>
                        </div>
                        <div>
                          <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Contact Phone</p>
                          <p className="text-sm font-medium text-slate-800 mt-0.5">{data.contact_phone || "Not provided"}</p>
                        </div>
                        <div>
                          <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Address</p>
                          <p className="text-sm font-medium text-slate-800 mt-0.5">{data.address || "Not provided"}</p>
                        </div>
                      </>
                    )}
                    
                    <div className="pt-4 border-t border-slate-100">
                      <p className="text-[10px] text-slate-400 font-medium">Created: {new Date(data.created_at).toLocaleString()}</p>
                    </div>
                  </div>
                </div>

                {/* Automation Quick Actions */}
                <div className="bg-gradient-to-br from-indigo-50 to-blue-50 p-5 rounded-2xl border border-indigo-100 shadow-sm">
                  <h3 className="text-xs font-bold text-indigo-800 uppercase tracking-wider mb-3">AI Quick Actions</h3>
                  <div className="space-y-2">
                    <button className="w-full flex items-center justify-between p-3 bg-white hover:bg-indigo-50 rounded-xl border border-indigo-200 text-sm font-semibold text-indigo-700 transition-colors shadow-sm">
                      <span>Analyze Risk Profile</span>
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
                    </button>
                    <button className="w-full flex items-center justify-between p-3 bg-white hover:bg-indigo-50 rounded-xl border border-indigo-200 text-sm font-semibold text-indigo-700 transition-colors shadow-sm">
                      <span>Generate Proposal</span>
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                    </button>
                  </div>
                </div>
              </div>

              {/* Right Column: Policies & Members */}
              <div className="lg:col-span-2 space-y-6">
                
                {/* Risk Overview (If Applicable) */}
                {entityType === 'INDIVIDUAL' && data.underwriting_score !== undefined && data.underwriting_score !== null && (
                  <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100 flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Underwriting AI Score</h3>
                      <p className="text-sm text-slate-600 font-medium">Auto-generated via risk engine parameters.</p>
                    </div>
                    <div className="text-center px-6 py-3 bg-slate-50 rounded-xl border border-slate-100">
                      <span className={`text-3xl font-black ${data.underwriting_score >= 80 ? 'text-emerald-500' : data.underwriting_score >= 50 ? 'text-amber-500' : 'text-red-500'}`}>
                        {data.underwriting_score}
                      </span>
                      <span className="text-xs font-bold text-slate-400 block mt-0.5">/ 100</span>
                    </div>
                  </div>
                )}

                {/* Relationship / Roster Data */}
                <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100 min-h-[300px]">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">
                    {entityType === 'INDIVIDUAL' ? 'Policy Portfolio' : entityType === 'FAMILY' ? 'Family Roster & Coverage' : 'Employee Census'}
                  </h3>
                  
                  <div className="flex flex-col items-center justify-center h-48 text-center bg-slate-50/50 rounded-xl border border-slate-100 border-dashed">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-12 h-12 text-slate-300 mb-3">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    </svg>
                    <p className="text-sm font-semibold text-slate-700">Detailed View Protected</p>
                    <p className="text-xs text-slate-500 mt-1 max-w-sm">To view complex nested data like medical evaluations or policy documents, please click the "Open Full Legacy Editor" button in the header.</p>
                  </div>
                </div>

              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
