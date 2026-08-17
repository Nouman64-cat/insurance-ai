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
        title="Payee Registry"
        subtitle="Producers, managers, corporate channels and introducers — with the licence and tax profile each payout is checked against"
        actions={
          <>
            <div className="flex rounded-xl border border-slate-200 overflow-hidden">
              <button
                onClick={() => setView("table")}
                className={`px-3 py-1.5 text-[11px] font-bold ${view === "table" ? "bg-blue-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
              >
                Registry
              </button>
              <button
                onClick={() => setView("hierarchy")}
                className={`px-3 py-1.5 text-[11px] font-bold ${view === "hierarchy" ? "bg-blue-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
              >
                Hierarchy
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
            placeholder="Search name, code, branch or licence…"
            className="flex-1 min-w-[240px] bg-slate-50 border border-slate-300 rounded-lg px-3 py-1.5 text-xs focus:outline-hidden focus:border-blue-500"
          />
          <select
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value as DistributionChannel | "all")}
            className="bg-slate-50 border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-700"
          >
            <option value="all">All channels</option>
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
            <option value="all">All payee types</option>
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
                  <th className="p-3">Payee</th>
                  <th className="p-3">Type &amp; Channel</th>
                  <th className="p-3">Reports To</th>
                  <th className="p-3">Licence</th>
                  <th className="p-3">Tax Profile</th>
                  <th className="p-3">Payment Details</th>
                  <th className="p-3 text-right">YTD Commission</th>
                  <th className="p-3 text-right">Recovery Due</th>
                  <th className="p-3 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-800">
                {filtered.map((p) => {
                  const upline = p.parentPayeeId ? byId.get(p.parentPayeeId) : null;
                  return (
                    <tr key={p.id} className="hover:bg-slate-50/80">
                      <td className="p-3">
                        <p className="font-bold text-slate-900">{p.name}</p>
                        <p className="text-[10px] font-mono text-slate-400">{p.code}</p>
                        <p className="text-[10px] text-slate-400">{p.branch}</p>
                      </td>
                      <td className="p-3 space-y-1">
                        <PayeeTypeBadge type={p.type} />
                        <div>
                          <ChannelBadge channel={p.channel} />
                        </div>
                      </td>
                      <td className="p-3">
                        {upline ? (
                          <div className="leading-tight">
                            <p className="font-semibold text-slate-800">{upline.name}</p>
                            <p className="text-[10px] text-slate-400">{PAYEE_TYPE_LABELS[upline.type]}</p>
                          </div>
                        ) : (
                          <span className="text-[10px] text-slate-400">Top of hierarchy</span>
                        )}
                      </td>
                      <td className="p-3">
                        <LicenceCell licenceNo={p.licenceNo} expiry={p.licenceExpiry} />
                      </td>
                      <td className="p-3">
                        <p className="text-[10px] font-bold text-slate-700">
                          {p.isCorporate ? "Corporate" : "Individual"} · {p.taxFilerStatus === "FILER" ? "Filer" : "Non-filer"}
                        </p>
                        <p className="text-[10px] text-slate-500">
                          WHT {resolveWhtPct(p)}%{p.isCorporate ? " + sales tax on services" : ""}
                        </p>
                        {p.taxId && <p className="text-[10px] font-mono text-slate-400">{p.taxId}</p>}
                      </td>
                      <td className="p-3">
                        {p.bankAccount ? (
                          <div className="leading-tight">
                            <p className="text-[10px] font-semibold text-slate-700">{p.bankName}</p>
                            <p className="text-[10px] font-mono text-slate-400">{p.bankAccount}</p>
                          </div>
                        ) : (
                          <span className="text-[10px] text-slate-400">No account on file</span>
                        )}
                      </td>
                      <td className="p-3 text-right font-semibold tabular-nums text-slate-800">{fmtPKR(p.ytdCommission)}</td>
                      <td className="p-3 text-right font-mono font-bold">
                        {p.recoveryBalance > 0 ? (
                          <span className="text-rose-600">{fmtPKR(p.recoveryBalance)}</span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
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

/** The override chain, drawn as the tree the engine actually walks. */
function HierarchyView({ payees, allPayees }: { payees: CommissionPayee[]; allPayees: CommissionPayee[] }) {
  const visible = new Set(payees.map((p) => p.id));
  const roots = allPayees.filter((p) => !p.parentPayeeId);

  const renderNode = (payee: CommissionPayee, depth: number): React.ReactNode => {
    const children = allPayees.filter((p) => p.parentPayeeId === payee.id);
    const subtree = children.map((c) => renderNode(c, depth + 1));
    const selfVisible = visible.has(payee.id);
    if (!selfVisible && subtree.every((n) => n === null)) return null;

    return (
      <div key={payee.id} className={depth > 0 ? "ml-5 border-l border-slate-200 pl-4" : ""}>
        <div
          className={`flex flex-wrap items-center gap-2 py-2 ${selfVisible ? "" : "opacity-40"}`}
        >
          <span className="font-bold text-xs text-slate-900">{payee.name}</span>
          <span className="font-mono text-[10px] text-slate-400">{payee.code}</span>
          <PayeeTypeBadge type={payee.type} />
          <ChannelBadge channel={payee.channel} />
          {payee.recoveryBalance > 0 && (
            <span className="text-[10px] font-bold text-rose-600">recovery {fmtPKR(payee.recoveryBalance)}</span>
          )}
          {payee.status !== "ACTIVE" && (
            <span className="text-[10px] font-bold text-amber-700">{payee.status}</span>
          )}
        </div>
        {subtree}
      </div>
    );
  };

  const tree = roots.map((r) => renderNode(r, 0)).filter(Boolean);

  return (
    <div className="p-5">
      {tree.length === 0 ? <EmptyState message="No payees match these filters." /> : tree}
      <p className="mt-4 text-[10px] text-slate-400">
        Overrides are computed by walking up this tree from the writing producer — each manager earns a percentage of
        their downline&apos;s commission, not of the premium.
      </p>
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
            <h3 className="font-bold text-sm text-slate-900">Add Commission Payee</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Banks, brokers, corporate agents, managers and referral partners are maintained here
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg font-bold">
            ✕
          </button>
        </div>

        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Payee Name">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Payee Code">
            <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Payee Type">
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
          <Field label="Distribution Channel">
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
          <Field label="Reports To (override chain)">
            <select
              value={form.parentPayeeId}
              onChange={(e) => setForm({ ...form, parentPayeeId: e.target.value })}
              className={selectClass}
            >
              <option value="">— Top of hierarchy —</option>
              {payees.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({PAYEE_TYPE_LABELS[p.type]})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Branch / Region">
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
          <Field label="Licence Expiry">
            <input
              type="date"
              value={form.licenceExpiry}
              onChange={(e) => setForm({ ...form, licenceExpiry: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label="Entity Type">
            <select
              value={form.isCorporate ? "corporate" : "individual"}
              onChange={(e) => setForm({ ...form, isCorporate: e.target.value === "corporate" })}
              className={selectClass}
            >
              <option value="individual">Individual (may qualify for the life-agent WHT band)</option>
              <option value="corporate">Corporate (standard WHT + sales tax on services)</option>
            </select>
          </Field>
          <Field label="Tax Filer Status">
            <select
              value={form.taxFilerStatus}
              onChange={(e) => setForm({ ...form, taxFilerStatus: e.target.value as TaxFilerStatus })}
              className={selectClass}
            >
              <option value="FILER">Filer (on the Active Taxpayers List)</option>
              <option value="NON_FILER">Non-filer (withheld at double rate)</option>
            </select>
          </Field>
          <Field label="CNIC / NTN">
            <input value={form.taxId} onChange={(e) => setForm({ ...form, taxId: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Bank">
            <input value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Account / IBAN">
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
