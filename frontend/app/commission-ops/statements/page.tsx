"use client";
import React, { useState, useCallback, useEffect } from "react";
import StatementsTab from "../../../components/commissions/StatementsTab";
import { PayeeStatement, listPayeeStatements } from "../../services/commissions";

export default function StatementsPage() {
  const [statements, setStatements] = useState<PayeeStatement[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const statementData = await listPayeeStatements();
      setStatements([...statementData]);
    } catch (err) {
      console.error("Could not load statements.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Payee Statements</h1>
            {/* <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">Commission Statements</span> */}
          </div>
        </div>
      </div>
      {loading && statements.length === 0 ? (
        <div className="px-5 py-12 text-center text-xs text-slate-400 bg-white rounded-xl shadow-sm border border-slate-200">Loading statements...</div>
      ) : (
        <StatementsTab statements={statements} />
      )}
    </div>
  );
}
