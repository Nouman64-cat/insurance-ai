"use client";
import { useI18n } from "@/lib/i18n/I18nProvider";

export function passwordChecks(pw: string, username = "") {
  return [
    { key: "length", ok: pw.length >= 10 },
    { key: "mix", ok: /[A-Za-z]/.test(pw) && /\d/.test(pw) },
    { key: "username", ok: !username || !pw.toLowerCase().includes(username.toLowerCase()) },
  ];
}

export function PasswordRules({ password, username }: { password: string; username?: string }) {
  const { t } = useI18n();
  return (
    <ul className="space-y-1 text-xs" aria-label={t("password.rules")}>
      {passwordChecks(password, username).map((c) => (
        <li key={c.key} className={`flex items-center gap-1.5 ${c.ok ? "text-emerald-700" : "text-slate-500"}`}>
          <span aria-hidden="true">{c.ok ? "✓" : "○"}</span>{t(`password.rule.${c.key}`)}
        </li>
      ))}
    </ul>
  );
}
