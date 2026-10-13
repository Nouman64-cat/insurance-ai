"use client";
import { useMemo, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { newIdempotencyKey } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { BeneficiariesView, MemberRow } from "@/lib/types";
import { Banner, Field, Modal, Spinner, errorText, tOr } from "./ui";

export type RequestKind = "MEMBER_ADD" | "MEMBER_REMOVE" | "MEMBER_CORRECTION" | "COVERAGE_CHANGE" | "NOMINEE_CHANGE" | "CONTACT_CORRECTION" | "CANCELLATION" | "REINSTATEMENT";

interface Row { name: string; relationship: string; share_pct: string; date_of_birth: string; guardian_name: string }
const RELATIONSHIPS = ["Spouse", "Child", "Parent", "Sibling", "Other"];
const CORRECTABLE = ["name", "dob", "cnic", "phone", "email", "relationship"];

/** One dialog for every servicing request a family customer can make. Nothing here changes an issued contract: the request is
 *  validated against the policy's current state, recorded, and handled by the insurer — the dialog says so before and after. */
export function RequestModal({ familyId, kind, policy, member, nominees, onClose, onDone }: {
  familyId: string; kind: RequestKind; policy?: { id: string; policy_number: string | null; sum_assured?: number };
  member?: MemberRow | null; nominees?: BeneficiariesView | null; onClose: () => void; onDone: () => void;
}) {
  const { t } = useI18n();
  const key = useRef(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<{ reference: string } | null>(null);
  const [f, setF] = useState({ reason: "", name: "", relationship: "Child", dob: "", cnic: "", insured: false, field: "name", value: "",
                              new_sum_assured: "", rider_note: "", contact_email: "", contact_phone: "" });
  const [rows, setRows] = useState<Row[]>(() => (nominees?.beneficiaries.length
    ? nominees.beneficiaries.map((b) => ({ name: b.name, relationship: b.relationship, share_pct: String(b.share_pct), date_of_birth: b.date_of_birth || "", guardian_name: b.guardian_name || "" }))
    : [{ name: "", relationship: "Spouse", share_pct: "100", date_of_birth: "", guardian_name: "" }]));
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF((x) => ({ ...x, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));
  const total = useMemo(() => Math.round(rows.reduce((a, r) => a + (Number(r.share_pct) || 0), 0) * 100) / 100, [rows]);

  const valid = (() => {
    switch (kind) {
      case "MEMBER_ADD": return !!f.name.trim() && !!f.dob && (!f.insured || f.relationship === "Spouse");
      case "MEMBER_REMOVE": return !!member && f.reason.trim().length >= 5;
      case "MEMBER_CORRECTION": return !!member && !!f.value.trim() && f.reason.trim().length >= 5;
      case "COVERAGE_CHANGE": return (Number(f.new_sum_assured) > 0 || f.rider_note.trim().length > 3);
      case "NOMINEE_CHANGE": return rows.length > 0 && Math.abs(total - 100) < 0.01 && rows.every((r) => r.name.trim().length > 1 && r.relationship.trim().length > 1 && Number(r.share_pct) > 0);
      case "CONTACT_CORRECTION": return !!(f.contact_email.trim() || f.contact_phone.trim());
      case "CANCELLATION": return f.reason.trim().length >= 5;
      case "REINSTATEMENT": return true;
    }
  })();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true); setError(null);
    const body: Record<string, unknown> = { kind, policy_id: policy?.id, reason: f.reason.trim() || undefined };
    if (kind === "MEMBER_ADD") Object.assign(body, { name: f.name.trim(), relationship: f.relationship, dob: f.dob, cnic: f.cnic.trim() || undefined, insured: f.insured });
    if (kind === "MEMBER_REMOVE" || kind === "MEMBER_CORRECTION") body.member_key = member?.key;
    if (kind === "MEMBER_CORRECTION") body.changes = { [f.field]: f.value.trim() };
    if (kind === "COVERAGE_CHANGE") Object.assign(body, { new_sum_assured: Number(f.new_sum_assured) || undefined, rider_note: f.rider_note.trim() || undefined });
    if (kind === "NOMINEE_CHANGE") body.beneficiaries = rows.map((r) => ({ name: r.name.trim(), relationship: r.relationship.trim(), share_pct: Number(r.share_pct),
      date_of_birth: r.date_of_birth || undefined, guardian_name: r.guardian_name.trim() || undefined }));
    if (kind === "CONTACT_CORRECTION") Object.assign(body, { contact_email: f.contact_email.trim() || undefined, contact_phone: f.contact_phone.trim() || undefined });
    try {
      const res = await api<{ reference: string }>(`family/${encodeURIComponent(familyId)}/requests`, { method: "POST", body, idempotencyKey: key.current });
      setDone({ reference: res.reference }); onDone();
    } catch (err) {
      const er = err as ApiError;
      setError(er); setBusy(false);
      if (!["NETWORK", "SERVICE_UNAVAILABLE", "DOMAIN_UNAVAILABLE", "REQUEST_IN_PROGRESS"].includes(er.code)) key.current = newIdempotencyKey();
    }
  }

  return (
    <Modal title={t(`request.kind.${kind}`)} onClose={onClose} busy={busy} wide={kind === "NOMINEE_CHANGE"}>
      {done ? (
        <div className="text-center py-2">
          <div className="w-12 h-12 mx-auto rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mb-3 text-2xl" aria-hidden="true">✓</div>
          <p className="font-bold text-slate-900">{t("request.sent")}</p>
          <p className="text-sm text-slate-500 mt-1">{t("request.sentText", { reference: done.reference })}</p>
          <button type="button" className="btn-primary mt-4" onClick={onClose}>{t("common.done")}</button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Banner tone="info">{t("request.notice")}</Banner>
          {error && <Banner tone="danger" title={errorText(t, error)}>{error.code === "SHARES_MUST_TOTAL_100" && t("request.sharesTotal", { total: String(error.details?.total ?? "") })}</Banner>}
          {policy && <p className="text-xs text-slate-500">{t("request.policy")}: <span className="font-semibold text-slate-700 ltr-num">{policy.policy_number}</span></p>}

          {kind === "MEMBER_ADD" && (
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label={t("profile.name")} htmlFor="rq-name"><input id="rq-name" className="input" value={f.name} onChange={set("name")} maxLength={255} required /></Field>
              <Field label={t("policy.relationship")} htmlFor="rq-rel"><select id="rq-rel" className="input" value={f.relationship} onChange={set("relationship")}>{RELATIONSHIPS.map((r) => <option key={r} value={r}>{tOr(t, `relationship.${r}`, r)}</option>)}</select></Field>
              <Field label={t("profile.dob")} htmlFor="rq-dob"><input id="rq-dob" type="date" className="input" value={f.dob} onChange={set("dob")} max={new Date().toISOString().slice(0, 10)} required /></Field>
              <Field label={t("profile.cnic")} htmlFor="rq-cnic" hint={t("request.cnicOptional")}><input id="rq-cnic" className="input" dir="ltr" value={f.cnic} onChange={set("cnic")} maxLength={20} /></Field>
              <label className="sm:col-span-2 flex items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" className="mt-1" checked={f.insured} onChange={set("insured")} disabled={f.relationship !== "Spouse"} />
                <span>{t("request.addInsured")}<span className="block text-xs text-slate-400">{t("request.addInsuredHint")}</span></span>
              </label>
            </div>
          )}

          {(kind === "MEMBER_REMOVE" || kind === "MEMBER_CORRECTION") && member && (
            <p className="rounded-xl bg-slate-50 border border-slate-100 px-4 py-3 text-sm"><span className="text-slate-500">{t("request.member")}: </span><span className="font-semibold text-slate-800">{member.name}</span> · {tOr(t, `relationship.${member.relationship}`, member.relationship)}</p>
          )}
          {kind === "MEMBER_REMOVE" && <p className="text-xs text-slate-500">{t("request.removeScope")}</p>}
          {kind === "MEMBER_CORRECTION" && (
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label={t("request.field")} htmlFor="rq-field"><select id="rq-field" className="input" value={f.field} onChange={set("field")}>{CORRECTABLE.map((c) => <option key={c} value={c}>{t(`request.fields.${c}`)}</option>)}</select></Field>
              <Field label={t("request.newValue")} htmlFor="rq-value"><input id="rq-value" className="input" value={f.value} onChange={set("value")} maxLength={255} required /></Field>
            </div>
          )}

          {kind === "COVERAGE_CHANGE" && (
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label={t("request.newCover")} htmlFor="rq-sum" hint={policy?.sum_assured ? t("request.currentCover", { amount: policy.sum_assured.toLocaleString("en-PK") }) : undefined}>
                <input id="rq-sum" type="number" min="1" step="any" className="input" dir="ltr" value={f.new_sum_assured} onChange={set("new_sum_assured")} /></Field>
              <Field label={t("request.benefitChange")} htmlFor="rq-rider"><input id="rq-rider" className="input" value={f.rider_note} onChange={set("rider_note")} maxLength={500} /></Field>
            </div>
          )}

          {kind === "NOMINEE_CHANGE" && (
            <div className="space-y-3">
              <div className="overflow-x-auto -mx-1">
                <table className="w-full min-w-[640px]"><thead><tr><th className="th">{t("profile.name")}</th><th className="th">{t("policy.relationship")}</th><th className="th">{t("policy.share")} %</th><th className="th">{t("profile.dob")}</th><th className="th">{t("request.guardian")}</th><th className="th" /></tr></thead>
                  <tbody>{rows.map((r, i) => (
                    <tr key={i}>
                      <td className="td"><input aria-label={t("profile.name")} className="input !py-1.5" value={r.name} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} maxLength={255} /></td>
                      <td className="td"><input aria-label={t("policy.relationship")} className="input !py-1.5" value={r.relationship} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, relationship: e.target.value } : x))} maxLength={100} /></td>
                      <td className="td"><input aria-label={t("policy.share")} type="number" min="0" max="100" step="any" dir="ltr" className="input !py-1.5 w-24" value={r.share_pct} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, share_pct: e.target.value } : x))} /></td>
                      <td className="td"><input aria-label={t("profile.dob")} type="date" className="input !py-1.5" value={r.date_of_birth} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, date_of_birth: e.target.value } : x))} /></td>
                      <td className="td"><input aria-label={t("request.guardian")} className="input !py-1.5" value={r.guardian_name} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, guardian_name: e.target.value } : x))} maxLength={255} /></td>
                      <td className="td"><button type="button" className="text-xs font-semibold text-rose-600" onClick={() => setRows(rows.filter((_, j) => j !== i))} disabled={rows.length === 1}>{t("common.remove")}</button></td>
                    </tr>))}</tbody></table>
              </div>
              <div className="flex items-center justify-between">
                <button type="button" className="btn-secondary !py-1.5 !min-h-0 text-xs" onClick={() => setRows([...rows, { name: "", relationship: "Child", share_pct: "", date_of_birth: "", guardian_name: "" }])} disabled={rows.length >= 12}>{t("request.addNominee")}</button>
                <p className={`text-sm font-bold ${Math.abs(total - 100) < 0.01 ? "text-emerald-700" : "text-rose-600"}`} aria-live="polite">{t("request.shareTotal", { total })}</p>
              </div>
              <p className="text-xs text-slate-500">{t("request.minorNote")}</p>
            </div>
          )}

          {kind === "CONTACT_CORRECTION" && (
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label={t("profile.email")} htmlFor="rq-email"><input id="rq-email" type="email" className="input" dir="ltr" value={f.contact_email} onChange={set("contact_email")} maxLength={255} /></Field>
              <Field label={t("profile.phone")} htmlFor="rq-phone"><input id="rq-phone" type="tel" className="input" dir="ltr" value={f.contact_phone} onChange={set("contact_phone")} maxLength={30} /></Field>
            </div>
          )}

          {kind !== "REINSTATEMENT" && kind !== "CONTACT_CORRECTION" && kind !== "MEMBER_ADD" && (
            <Field label={t("request.reason")} htmlFor="rq-reason"><textarea id="rq-reason" className="input min-h-[80px]" value={f.reason} onChange={set("reason")} maxLength={2000} required={["MEMBER_REMOVE", "MEMBER_CORRECTION", "CANCELLATION"].includes(kind)} /></Field>
          )}
          {(kind === "REINSTATEMENT" || kind === "MEMBER_ADD" || kind === "CONTACT_CORRECTION") && (
            <Field label={t("request.note")} htmlFor="rq-note"><textarea id="rq-note" className="input min-h-[70px]" value={f.reason} onChange={set("reason")} maxLength={2000} /></Field>
          )}
          {kind === "CANCELLATION" && <Banner tone="warning">{t("request.cancelWarning")}</Banner>}

          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
            <button type="submit" className="btn-primary" disabled={!valid || busy}>{busy ? <><Spinner />{t("common.submitting")}</> : t("request.submit")}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
