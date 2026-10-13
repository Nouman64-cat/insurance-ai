"use client";
import { useState } from "react";
import { PasswordInput } from "@/components/PasswordInput";
import { PasswordRules, passwordChecks } from "@/components/PasswordRules";
import { Banner, Card, ErrorState, Field, KeyValue, Modal, PageHeader, Skeleton, Spinner, errorText, useToast } from "@/components/ui";
import { ApiError, api, authPost, useApi } from "@/lib/api";
import { date } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { Profile } from "@/lib/types";

function EditContact({ p, onClose, onSaved }: { p: Profile; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [f, setF] = useState({ email: p.email || "", phone: p.phone || "", address: p.address || "" });
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const changed = (["email", "phone", "address"] as const).filter((k) => f[k].trim() !== (p[k] || ""));
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body: Record<string, string> = { current_password: pw };
      changed.forEach((k) => { body[k] = f[k].trim(); });
      await api("profile/contact", { method: "PATCH", body });
      toast(t("profile.contactSaved"), "success"); onSaved(); onClose();
    } catch (err) { setError(err as ApiError); setBusy(false); }
  }
  return (
    <Modal title={t("profile.editContact")} onClose={onClose} busy={busy}>
      <form onSubmit={save} className="space-y-4">
        {error && <Banner tone="danger" title={errorText(t, error)} />}
        <Field label={t("profile.email")} htmlFor="email"><input id="email" type="email" className="input" dir="ltr" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={255} autoComplete="email" /></Field>
        <Field label={t("profile.phone")} htmlFor="phone"><input id="phone" type="tel" className="input" dir="ltr" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={30} autoComplete="tel" /></Field>
        <Field label={t("profile.address")} htmlFor="address"><textarea id="address" className="input min-h-[80px]" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} maxLength={500} autoComplete="street-address" /></Field>
        <Field label={t("profile.confirmPassword")} htmlFor="pw" hint={t("profile.confirmPasswordHint")}><PasswordInput id="pw" value={pw} onChange={setPw} autoComplete="current-password" /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
          <button type="submit" className="btn-primary" disabled={busy || changed.length === 0 || !pw}>{busy ? <><Spinner />{t("common.saving")}</> : t("common.save")}</button></div>
      </form>
    </Modal>
  );
}

function ChangePassword({ username }: { username: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const [cur, setCur] = useState(""); const [next, setNext] = useState(""); const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const ok = passwordChecks(next, username).every((c) => c.ok) && next === again && next !== cur && !!cur;
  const problems: string[] = Array.isArray(error?.details?.problems) ? error!.details.problems : [];
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (!ok) return;
    setBusy(true); setError(null);
    try {
      await authPost("password", { current_password: cur, new_password: next });
      toast(t("profile.passwordChanged"), "success"); setCur(""); setNext(""); setAgain("");
    } catch (err) { setError(err as ApiError); }
    finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="space-y-4 max-w-md">
      {error && <Banner tone="danger" title={problems.length ? t("first.weak") : errorText(t, error)}>{problems.length > 0 && <ul className="list-disc ms-4">{problems.map((p) => <li key={p}>{t(`password.problem.${p}`)}</li>)}</ul>}</Banner>}
      <Field label={t("profile.currentPassword")} htmlFor="cur"><PasswordInput id="cur" value={cur} onChange={setCur} autoComplete="current-password" /></Field>
      <Field label={t("first.new")} htmlFor="new2"><PasswordInput id="new2" value={next} onChange={setNext} autoComplete="new-password" /></Field>
      <PasswordRules password={next} username={username} />
      <Field label={t("first.confirm")} htmlFor="again" error={again && next !== again ? t("first.mismatch") : null}><PasswordInput id="again" value={again} onChange={setAgain} autoComplete="new-password" /></Field>
      <button type="submit" className="btn-primary" disabled={!ok || busy}>{busy ? <><Spinner />{t("common.saving")}</> : t("profile.changePassword")}</button>
      <p className="text-xs text-slate-400">{t("profile.signOutOthers")}</p>
    </form>
  );
}

export default function ProfilePage() {
  const { t, locale } = useI18n();
  const { data: p, error, loading, reload } = useApi<Profile>("profile");
  const [editing, setEditing] = useState(false);
  if (error && !p) return <div className="card"><ErrorState error={error} onRetry={reload} /></div>;
  if (loading || !p) return <div className="space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></div>;
  return (
    <div className="space-y-5">
      <PageHeader title={t("profile.title")} subtitle={t("profile.subtitle")} />
      <div className="grid lg:grid-cols-2 gap-5">
        <Card title={t("profile.personal")}>
          <KeyValue label={t("profile.name")}>{p.name}</KeyValue>
          <KeyValue label={t("profile.policyholderId")}><span className="ltr-num">{p.policyholder_id || p.username}</span></KeyValue>
          <KeyValue label={t("profile.cnic")}><span className="ltr-num">{p.cnic_masked}</span></KeyValue>
          <KeyValue label={t("profile.dob")}>{date(p.dob, locale)}</KeyValue>
          <p className="text-xs text-slate-400 pt-3">{t("profile.identityNote")}</p>
        </Card>
        <Card title={t("profile.contact")} action={<button type="button" className="text-xs font-semibold text-blue-600 hover:text-blue-700" onClick={() => setEditing(true)}>{t("common.edit")}</button>}>
          <KeyValue label={t("profile.email")}>{p.email}</KeyValue>
          <KeyValue label={t("profile.phone")}><span className="ltr-num">{p.phone}</span></KeyValue>
          <KeyValue label={t("profile.address")}>{p.address}</KeyValue>
          <KeyValue label={t("profile.city")}>{[p.city, p.province].filter(Boolean).join(", ")}</KeyValue>
        </Card>
      </div>
      <div id="security"><Card title={t("profile.security")}><ChangePassword username={p.username} /></Card></div>
      {editing && <EditContact p={p} onClose={() => setEditing(false)} onSaved={reload} />}
    </div>
  );
}
