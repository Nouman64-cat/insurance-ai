"use client";

import React, { useMemo, useState } from "react";
import {
  CHANNEL_LABELS,
  CommissionPayee,
  DistributionChannel,
  PAYEE_TYPE_LABELS,
  PayeeType,
  TaxFilerStatus,
  createPayee,
  resolveWhtPct,
  updatePayee,
} from "../../app/services/commissions";
import {
  Card,
  ChannelBadge,
  EmptyState,
  Field,
  LicenceCell,
  PayeeTypeBadge,
  fmtPKR,
  inputClass,
  selectClass,
} from "./shared";

const PAYEE_TYPES = Object.keys(PAYEE_TYPE_LABELS) as PayeeType[];
const CHANNELS = Object.keys(CHANNEL_LABELS) as DistributionChannel[];

/**
 * The payee registry: everyone who can be owed commission, the override chain
 * they sit in, and the two things that decide whether they can legally be paid —
 * a valid licence and a tax profile.
 */
export default function PayeesTab({
  payees,
  onChanged,
  notify,
}: {
  payees: CommissionPayee[];
  onChanged: () => void;
  notify: (msg: string, ok?: boolean) => void;
}) {
  const [typeFilter, setTypeFilter] = useState<PayeeType | "all">("all");
  const [channelFilter, setChannelFilter] = useState<DistributionChannel | "all">("all");
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [view, setView] = useState<"table" | "hierarchy">("table");

  const byId = useMemo(() => new Map(payees.map((p) => [p.id, p])), [payees]);

  const filtered = payees.filter((p) => {
    if (typeFilter !== "all" && p.type !== typeFilter) return false;
    if (channelFilter !== "all" && p.channel !== channelFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        p.code.toLowerCase().includes(q) ||
        p.branch.toLowerCase().includes(q) ||
        (p.licenceNo ?? "").toLowerCase().includes(q)
      );
    }
    return true;
  });

  const toggleStatus = async (payee: CommissionPayee) => {
    const next = payee.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
    try {
      await updatePayee(payee.id, { status: next });
      notify(`${payee.name} is now ${next.toLowerCase()}. Existing entries re-gate on the next refresh.`);
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not update the payee", false);
    }
  };

  const counts = PAYEE_TYPES.map((t) => ({ type: t, count: payees.filter((p) => p.type === t).length })).filter(
    (c) => c.count > 0,
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {counts.map((c) => (
          <button
            key={c.type}
            onClick={() => setTypeFilter(typeFilter === c.type ? "all" : c.type)}
            className={`px-3 py-2 rounded-xl border text-xs font-bold transition-all ${
              typeFilter === c.type
                ? "bg-blue-600 text-white border-blue-600"
                : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
            }`}
          >
            {PAYEE_TYPE_LABELS[c.type]}
            <span className={`ml-2 font-mono ${typeFilter === c.type ? "text-blue-100" : "text-slate-400"}`}>
              {c.count}
            </span>
          </button>
        ))}
      </div>

      <Card
        title="Payees & Hierarchy"
        subtitle="List of all agents, managers, banks, and partners entitled to receive commissions"
        actions={
          <>
            <div className="flex rounded-xl border border-slate-200 overflow-hidden">
              <button
                onClick={() => setView("table")}
                className={`px-3 py-1.5 text-[11px] font-bold ${view === "table" ? "bg-blue-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
              >
                Table View
              </button>
              <button
                onClick={() => setView("hierarchy")}
                className={`px-3 py-1.5 text-[11px] font-bold ${view === "hierarchy" ? "bg-blue-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
              >
                Tree View
              </button>
            </div>
            <button
              onClick={() => setShowAdd(true)}
              className="px-3.5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold"
            >
              + Add Payee
            </button>
          </>
        }
      >
        <div className="px-5 py-3 border-b border-slate-100 flex flex-wrap gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, code, branch, or licence…"
            className="flex-1 min-w-[240px] bg-slate-50 border border-slate-300 rounded-lg px-3 py-1.5 text-xs focus:outline-hidden focus:border-blue-500"
          />
          <select
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value as DistributionChannel | "all")}
            className="bg-slate-50 border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-700"
          >
            <option value="all">All Channels</option>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABELS[c]}
              </option>
            ))}
          </select>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as PayeeType | "all")}
            className="bg-slate-50 border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-700"
          >
            <option value="all">All Roles</option>
            {PAYEE_TYPES.map((t) => (
              <option key={t} value={t}>
                {PAYEE_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>

        {view === "hierarchy" ? (
          <HierarchyView payees={filtered} allPayees={payees} />
        ) : filtered.length === 0 ? (
          <EmptyState message="No payees match these filters." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50/80 text-slate-500 font-medium uppercase tracking-wider text-[10px] border-b border-slate-200">
                <tr>
                  <th className="p-3">PAYEE</th>
                  <th className="p-3">TYPE</th>
                  <th className="p-3">SOURCE</th>
                  <th className="p-3">PAYEE LIC. REF.</th>
                  <th className="p-3 text-center">PAYEE STATUS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-800">
                {filtered.map((p) => {
                  return (
                    <tr key={p.id} className="hover:bg-slate-50/80">
                      <td className="p-3">
                        <p className="font-bold text-slate-900">{p.name}</p>
                        <p className="text-[10px] font-mono text-slate-400">{p.code}</p>
                        <p className="text-[10px] text-slate-400">{p.branch}</p>
                      </td>
                      <td className="p-3">
                        <PayeeTypeBadge type={p.type} />
                      </td>
                      <td className="p-3">
                        <ChannelBadge channel={p.channel} />
                      </td>
                      <td className="p-3">
                        <LicenceCell licenceNo={p.licenceNo} expiry={p.licenceExpiry} />
                      </td>
                      <td className="p-3 text-center">
                        <button
                          onClick={() => toggleStatus(p)}
                          title="Suspending a payee blocks every payout to them"
                          className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border ${
                            p.status === "ACTIVE"
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : "bg-amber-50 text-amber-800 border-amber-200"
                          }`}
                        >
                          {p.status}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {showAdd && (
        <AddPayeeModal
          payees={payees}
          onClose={() => setShowAdd(false)}
          onSaved={(name) => {
            setShowAdd(false);
            notify(`${name} added to the payee registry.`);
            onChanged();
          }}
          notify={notify}
        />
      )}
    </div>
  );
}

/** The override chain, drawn as an executive hierarchy tree. */
function HierarchyView({ payees, allPayees }: { payees: CommissionPayee[]; allPayees: CommissionPayee[] }) {
  const visible = new Set(payees.map((p) => p.id));
  const roots = allPayees.filter((p) => !p.parentPayeeId);

  const getPayeeIcon = (type: PayeeType) => {
    if (type === "BRANCH_MANAGER" || type === "SALES_MANAGER") {
      return (
        <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-200 text-blue-700 flex items-center justify-center shrink-0">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
        </div>
      );
    }
    if (type === "BANK_PARTNER" || type === "AGENCY" || type === "BROKER") {
      return (
        <div className="w-8 h-8 rounded-lg bg-purple-50 border border-purple-200 text-purple-700 flex items-center justify-center shrink-0">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          </svg>
        </div>
      );
    }
    return (
      <div className="w-8 h-8 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 flex items-center justify-center shrink-0">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
        </svg>
      </div>
    );
  };

  const renderNode = (payee: CommissionPayee, depth: number): React.ReactNode => {
    const children = allPayees.filter((p) => p.parentPayeeId === payee.id);
    const subtree = children.map((c) => renderNode(c, depth + 1)).filter(Boolean);
    const selfVisible = visible.has(payee.id);
    if (!selfVisible && subtree.length === 0) return null;

    return (
      <div key={payee.id} className="relative">
        {/* L-shaped connecting line for child nodes */}
        {depth > 0 && (
          <div className="absolute -left-6 top-5 w-4 h-4 border-l-2 border-b-2 border-blue-300 rounded-bl-lg pointer-events-none" />
        )}

        <div
          className={`flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl border bg-white shadow-2xs hover:shadow-xs transition-all ${
            selfVisible ? "border-slate-200 hover:border-blue-300" : "border-slate-100 opacity-40"
          }`}
        >
          <div className="flex items-center gap-3 min-w-0">
            {getPayeeIcon(payee.type)}
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-xs text-slate-900">{payee.name}</span>
                <span className="font-mono text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                  {payee.code}
                </span>
                <span className="text-[10px] text-slate-400 font-medium">· {payee.branch}</span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <PayeeTypeBadge type={payee.type} />
                <ChannelBadge channel={payee.channel} />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {children.length > 0 && (
              <span className="px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-bold border border-blue-200">
                {children.length} {children.length === 1 ? "Direct Report" : "Direct Reports"}
              </span>
            )}
            {payee.recoveryBalance > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 text-[10px] font-bold border border-rose-200">
                Recovery: {fmtPKR(payee.recoveryBalance)}
              </span>
            )}
            <span
              className={`px-2.5 py-0.5 rounded-full text-[10px] font-semibold border ${
                payee.status === "ACTIVE"
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                  : "bg-amber-50 text-amber-800 border-amber-200"
              }`}
            >
              {payee.status}
            </span>
          </div>
        </div>

        {subtree.length > 0 && (
          <div className="pl-8 ml-3 border-l-2 border-blue-200 mt-2 space-y-2.5 relative">
            {subtree}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="p-5 space-y-5">
      <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-blue-600"></span>
          <span className="font-bold text-slate-800">Team &amp; Channel Tree</span>
          <span className="text-slate-400">|</span>
          <span>Commission overrides flow upward to direct managers</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 bg-white border border-slate-200 rounded text-[10px] font-mono font-semibold text-slate-700">
            {allPayees.length} Total Payees
          </span>
          <span className="px-2 py-0.5 bg-white border border-slate-200 rounded text-[10px] font-mono font-semibold text-slate-700">
            {roots.length} Channel Groups
          </span>
        </div>
      </div>

      {roots.length === 0 ? (
        <EmptyState message="No payees match these filters." />
      ) : (
        <div className="space-y-6">
          {roots.map((root) => {
            const nodeContent = renderNode(root, 0);
            if (!nodeContent) return null;
            return (
              <div
                key={root.id}
                className="p-4 bg-slate-50/60 border border-slate-200 rounded-2xl space-y-3 shadow-2xs hover:border-slate-300 transition-all"
              >
                <div className="flex items-center justify-between border-b border-slate-200/80 pb-2.5">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-blue-600"></span>
                    <h4 className="font-extrabold text-xs text-slate-800 uppercase tracking-wider">
                      {CHANNEL_LABELS[root.channel]} Team
                    </h4>
                    <span className="text-[10px] text-slate-400 font-medium">
                      · Main Head: <span className="font-semibold text-slate-700">{root.name}</span>
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-400 bg-white px-2 py-0.5 rounded border border-slate-200">
                    Channel Head
                  </span>
                </div>
                {nodeContent}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AddPayeeModal({
  payees,
  onClose,
  onSaved,
  notify,
}: {
  payees: CommissionPayee[];
  onClose: () => void;
  onSaved: (name: string) => void;
  notify: (msg: string, ok?: boolean) => void;
}) {
  const [form, setForm] = useState({
    name: "",
    code: "",
    type: "BROKER" as PayeeType,
    channel: "BROKER" as DistributionChannel,
    parentPayeeId: "",
    branch: "Karachi",
    licenceNo: "",
    licenceExpiry: "",
    isCorporate: true,
    taxFilerStatus: "FILER" as TaxFilerStatus,
    taxId: "",
    bankName: "",
    bankAccount: "",
  });

  const save = async () => {
    if (!form.name.trim() || !form.code.trim()) {
      notify("Name and code are required.", false);
      return;
    }
    try {
      await createPayee({
        name: form.name.trim(),
        code: form.code.trim(),
        type: form.type,
        channel: form.channel,
        parentPayeeId: form.parentPayeeId || null,
        status: "ACTIVE",
        branch: form.branch,
        licenceNo: form.licenceNo || null,
        licenceExpiry: form.licenceExpiry || null,
        isCorporate: form.isCorporate,
        taxFilerStatus: form.taxFilerStatus,
        taxId: form.taxId || null,
        bankName: form.bankName || null,
        bankAccount: form.bankAccount || null,
        persistency13m: null,
      });
      onSaved(form.name.trim());
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not add the payee", false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs px-4 py-8 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl border border-slate-200 overflow-hidden">
        <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex items-center justify-between text-slate-900">
          <div>
            <h3 className="font-bold text-sm text-slate-900">Add New Payee</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Register a new agent, manager, bank, or partner.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg font-bold">
            ✕
          </button>
        </div>

        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Name">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Code">
            <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Role / Category">
            <select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value as PayeeType })}
              className={selectClass}
            >
              {PAYEE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {PAYEE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Source Channel">
            <select
              value={form.channel}
              onChange={(e) => setForm({ ...form, channel: e.target.value as DistributionChannel })}
              className={selectClass}
            >
              {CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reports To (Manager)">
            <select
              value={form.parentPayeeId}
              onChange={(e) => setForm({ ...form, parentPayeeId: e.target.value })}
              className={selectClass}
            >
              <option value="">— None (Top Manager) —</option>
              {payees.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({PAYEE_TYPE_LABELS[p.type]})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Branch">
            <input value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Licence Number">
            <input
              value={form.licenceNo}
              onChange={(e) => setForm({ ...form, licenceNo: e.target.value })}
              placeholder="Required for agents, agencies, brokers and banks"
              className={inputClass}
            />
          </Field>
          <Field label="Licence Expiry Date">
            <input
              type="date"
              value={form.licenceExpiry}
              onChange={(e) => setForm({ ...form, licenceExpiry: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label="Tax Category">
            <select
              value={form.isCorporate ? "corporate" : "individual"}
              onChange={(e) => setForm({ ...form, isCorporate: e.target.value === "corporate" })}
              className={selectClass}
            >
              <option value="individual">Individual Agent</option>
              <option value="corporate">Company / Bank</option>
            </select>
          </Field>
          <Field label="Tax Filer Status">
            <select
              value={form.taxFilerStatus}
              onChange={(e) => setForm({ ...form, taxFilerStatus: e.target.value as TaxFilerStatus })}
              className={selectClass}
            >
              <option value="FILER">Tax Filer (Lower Tax Rate)</option>
              <option value="NON_FILER">Non-Filer (Standard Tax Rate)</option>
            </select>
          </Field>
          <Field label="Tax ID / CNIC">
            <input value={form.taxId} onChange={(e) => setForm({ ...form, taxId: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Bank Name">
            <input value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Account Number / IBAN">
            <input
              value={form.bankAccount}
              onChange={(e) => setForm({ ...form, bankAccount: e.target.value })}
              className={inputClass}
            />
          </Field>
        </div>

        <div className="border-t border-slate-200 px-6 py-3 flex justify-end gap-2 bg-slate-50">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-white border border-slate-300 font-bold rounded-xl text-slate-700 text-xs hover:bg-slate-100"
          >
            Cancel
          </button>
          <button onClick={save} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl text-xs shadow-md">
            Add Payee
          </button>
        </div>
      </div>
    </div>
  );
}
