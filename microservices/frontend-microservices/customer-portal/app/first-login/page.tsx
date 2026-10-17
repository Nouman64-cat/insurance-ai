"use client";
import { useState } from "react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { PasswordInput } from "@/components/PasswordInput";
import { PasswordRules, passwordChecks } from "@/components/PasswordRules";
import { Banner, Field, Icon, Spinner, errorText } from "@/components/ui";
import { ApiError, authPost } from "@/lib/api";
import { useI18n } from "@/lib/i18n/I18nProvider";

export default function FirstLoginPage() {
  const { t } = useI18n();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const ok = passwordChecks(next).every((c) => c.ok) && next === confirm && next !== current && current.length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      await authPost("first-change", { current_password: current, new_password: next });
      window.location.assign("/dashboard");
    } catch (err) {
      setError(err as ApiError); setBusy(false);
    }
  }

  async function cancel() {
    try { await authPost("logout"); } catch { /* ignore */ }
    window.location.assign("/login");
  }

  const problems: string[] = Array.isArray(error?.details?.problems) ? error!.details.problems : [];
  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-50 via-white to-blue-50">
      <div className="flex justify-end p-4"><LanguageSwitcher /></div>
      <main className="flex-1 flex items-center justify-center px-4 pb-12">
        <div className="w-full max-w-md">
          <div className="flex flex-col items-center mb-6 text-center">
            <span className="w-14 h-14 rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-200 mb-3"><Icon name="lock" className="w-7 h-7" /></span>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("first.title")}</h1>
            <p className="text-sm text-slate-500 mt-1">{t("first.subtitle")}</p>
          </div>
          <form onSubmit={submit} className="card p-6 space-y-4">
            {error && (
              <Banner tone="danger" title={problems.length ? t("first.weak") : errorText(t, error)}>
                {problems.length > 0 && <ul className="list-disc ms-4">{problems.map((p) => <li key={p}>{t(`password.problem.${p}`)}</li>)}</ul>}
              </Banner>
            )}
            <Field label={t("first.current")} htmlFor="current" hint={t("first.currentHint")}>
              <PasswordInput id="current" value={current} onChange={setCurrent} autoComplete="current-password" />
            </Field>
            <Field label={t("first.new")} htmlFor="new">
              <PasswordInput id="new" value={next} onChange={setNext} autoComplete="new-password" />
            </Field>
            <PasswordRules password={next} />
            <Field label={t("first.confirm")} htmlFor="confirm" error={confirm && next !== confirm ? t("first.mismatch") : null}>
              <PasswordInput id="confirm" value={confirm} onChange={setConfirm} autoComplete="new-password" />
            </Field>
            <button type="submit" disabled={!ok || busy} className="btn-primary w-full">{busy ? <><Spinner />{t("common.saving")}</> : t("first.submit")}</button>
            <button type="button" onClick={cancel} className="w-full text-xs font-semibold text-slate-500 hover:text-slate-800">{t("first.cancel")}</button>
          </form>
        </div>
      </main>
    </div>
  );
}
