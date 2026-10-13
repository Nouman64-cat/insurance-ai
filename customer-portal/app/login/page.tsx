"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { PasswordInput } from "@/components/PasswordInput";
import { Banner, Field, Icon, Spinner, errorText } from "@/components/ui";
import { ApiError, authPost } from "@/lib/api";
import { useI18n } from "@/lib/i18n/I18nProvider";

function LoginForm() {
  const { t } = useI18n();
  const params = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [tenant, setTenant] = useState("");
  const [needsTenant, setNeedsTenant] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await authPost<{ must_change_password: boolean }>("login", { username: username.trim(), password, ...(tenant.trim() ? { tenant_code: tenant.trim() } : {}) });
      const next = params.get("next");
      const safe = next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") ? next : "/dashboard";
      // A full load, so the middleware sees the new session cookies and routes (first-login vs dashboard) correctly.
      window.location.assign(res.must_change_password ? "/first-login" : safe);
    } catch (err) {
      const e2 = err as ApiError;
      if (e2.code === "TENANT_CODE_REQUIRED") setNeedsTenant(true);
      setError(e2);
      setPassword("");
      setBusy(false);
    }
  }

  const expired = params.get("expired") === "1";
  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-50 via-white to-blue-50">
      <div className="flex justify-end p-4"><LanguageSwitcher /></div>
      <main className="flex-1 flex items-center justify-center px-4 pb-12">
        <div className="w-full max-w-md">
          <div className="flex flex-col items-center mb-6">
            <span className="w-14 h-14 rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-200 mb-3"><Icon name="shield" className="w-8 h-8" /></span>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("brand.name")}</h1>
            <p className="text-sm text-slate-500 mt-0.5">{t("login.subtitle")}</p>
          </div>
          <form onSubmit={submit} className="card p-6 space-y-4" noValidate={false}>
            {expired && !error && <Banner tone="warning">{t("login.expired")}</Banner>}
            {error && <Banner tone="danger" title={errorText(t, error)} />}
            <Field label={t("login.username")} htmlFor="username" hint={t("login.usernameHint")}>
              <input id="username" name="username" className="input" dir="ltr" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username"
                autoCapitalize="none" autoCorrect="off" spellCheck={false} required maxLength={255} autoFocus />
            </Field>
            <Field label={t("login.password")} htmlFor="password">
              <PasswordInput id="password" value={password} onChange={setPassword} autoComplete="current-password" />
            </Field>
            {needsTenant ? (
              <Field label={t("login.company")} htmlFor="tenant" hint={t("login.companyHint")}>
                <input id="tenant" name="tenant" className="input" dir="ltr" value={tenant} onChange={(e) => setTenant(e.target.value)} autoCapitalize="characters" maxLength={50} required />
              </Field>
            ) : (
              <button type="button" onClick={() => setNeedsTenant(true)} className="text-xs font-semibold text-blue-600 hover:text-blue-700">{t("login.haveCompany")}</button>
            )}
            <button type="submit" disabled={busy || !username.trim() || !password} className="btn-primary w-full">
              {busy ? <><Spinner />{t("login.signingIn")}</> : t("login.signIn")}
            </button>
            <div className="pt-1 space-y-2 text-xs text-slate-500">
              <p>{t("login.noRegistration")}</p>
              <p>{t("login.forgot")}</p>
            </div>
          </form>
          <p className="text-center text-[11px] text-slate-400 mt-5">{t("login.secure")}</p>
        </div>
      </main>
    </div>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
