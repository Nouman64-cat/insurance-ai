"use client";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { Banner, Field, Icon, Spinner, errorText } from "@/components/ui";
import { ApiError, authPost } from "@/lib/api";
import { useI18n } from "@/lib/i18n/I18nProvider";

function Start() {
  const { t } = useI18n();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [devMode, setDevMode] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [demo, setDemo] = useState(false);          // demo mode: just the email, no verification code
  useEffect(() => { fetch("/api/portal/public/config", { cache: "no-store" }).then((r) => r.json()).then((c) => setDemo(!!c.demo)).catch(() => undefined); }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await authPost<{ sent: boolean; dev_mode?: boolean; demo?: boolean }>("walk-in/request-otp", { email: email.trim() });
      if (r.demo) {                                    // demo: no code is sent or asked for, so sign straight in
        await authPost("walk-in/verify", { email: email.trim() });
        window.location.assign("/walk-in/apply");
        return;
      }
      setDevMode(!!r.dev_mode); setStep("code"); setCode(""); setCooldown(30);
    } catch (err) { setError(err as ApiError); }
    finally { setBusy(false); }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await authPost("walk-in/verify", { email: email.trim(), code: code.trim() });
      window.location.assign("/walk-in/apply");        // a full load so the middleware sees the new session cookie
    } catch (err) { setError(err as ApiError); setBusy(false); }
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-50 via-white to-blue-50">
      <div className="flex justify-end p-4"><LanguageSwitcher /></div>
      <main className="flex-1 flex items-center justify-center px-4 pb-12">
        <div className="w-full max-w-md">
          <div className="flex flex-col items-center mb-6">
            <span className="w-14 h-14 rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-200 mb-3"><Icon name="shield" className="w-8 h-8" /></span>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("walkin.start.title")}</h1>
            <p className="text-sm text-slate-500 mt-0.5 text-center">{t("walkin.start.subtitle")}</p>
          </div>
          <div className="card p-6 space-y-4">
            {params.get("expired") === "1" && !error && <Banner tone="warning">{t("walkin.start.expired")}</Banner>}
            {error && <Banner tone="danger" title={errorText(t, error)} />}
            {step === "email" ? (
              <form onSubmit={sendCode} className="space-y-4">
                <Field label={t("walkin.start.email")} htmlFor="email" hint={demo ? t("walkin.start.emailHintDemo") : t("walkin.start.emailHint")}>
                  <input id="email" type="email" className="input" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required maxLength={255} autoFocus />
                </Field>
                <button type="submit" disabled={busy || !email.trim()} className="btn-primary w-full">{busy ? <><Spinner />{demo ? t("walkin.start.continuing") : t("walkin.start.sending")}</> : demo ? t("walkin.start.continue") : t("walkin.start.sendCode")}</button>
              </form>
            ) : (
              <form onSubmit={verify} className="space-y-4">
                <p className="text-sm text-slate-600">{t("walkin.start.sentTo", { email: email.trim() })}</p>
                {devMode && <Banner tone="warning">{t("walkin.start.devMode")}</Banner>}
                <Field label={t("walkin.start.code")} htmlFor="code">
                  <input id="code" inputMode="numeric" autoComplete="one-time-code" className="input tracking-[0.4em] text-center text-lg" dir="ltr" value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))} required autoFocus />
                </Field>
                <button type="submit" disabled={busy || code.length < 4} className="btn-primary w-full">{busy ? <><Spinner />{t("walkin.start.verifying")}</> : t("walkin.start.verify")}</button>
                <div className="flex items-center justify-between text-xs">
                  <button type="button" className="font-semibold text-blue-600 disabled:text-slate-400" onClick={() => sendCode()} disabled={busy || cooldown > 0}>
                    {cooldown > 0 ? t("walkin.start.resendIn", { seconds: cooldown }) : t("walkin.start.resend")}
                  </button>
                  <button type="button" className="font-semibold text-slate-500" onClick={() => { setStep("email"); setError(null); }}>{t("walkin.start.changeEmail")}</button>
                </div>
              </form>
            )}
            <p className="pt-1 text-xs text-slate-500">{t("walkin.start.privacy")}</p>
            <p className="text-xs text-slate-500">{t("walkin.start.haveAccount")} <Link href="/login" className="font-semibold text-blue-600">{t("walkin.start.signIn")}</Link></p>
          </div>
        </div>
      </main>
    </div>
  );
}

export default function WalkInStart() { return <Suspense><Start /></Suspense>; }
