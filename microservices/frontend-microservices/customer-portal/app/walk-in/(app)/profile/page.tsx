"use client";
import { useEffect, useState } from "react";
import { Banner, Card, ErrorState, Field, KeyValue, PageHeader, Skeleton, Spinner, errorText, useToast } from "@/components/ui";
import { ApiError, api, useApi } from "@/lib/api";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { WalkInProfile } from "@/lib/types";

export default function WalkInProfilePage() {
  const { t } = useI18n();
  const toast = useToast();
  const me = useApi<WalkInProfile>("walk-in/me");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => { if (me.data) setName(me.data.display_name); }, [me.data]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api("walk-in/profile", { method: "PATCH", body: { display_name: name.trim() } }); toast(t("walkin.profile.saved"), "success"); me.reload(); }
    catch (err) { setError(err as ApiError); }
    finally { setBusy(false); }
  }
  if (me.error) return <ErrorState error={me.error} onRetry={me.reload} />;
  return (
    <>
      <PageHeader title={t("walkin.profile.title")} subtitle={t("walkin.profile.subtitle")} />
      <Card>
        {me.loading ? <Skeleton className="h-24 w-full" /> : (
          <form onSubmit={save} className="space-y-4 max-w-md">
            {error && <Banner tone="danger" title={errorText(t, error)} />}
            <KeyValue label={t("walkin.apply.email")}><span dir="ltr">{me.data?.email}</span></KeyValue>
            <Field label={t("walkin.profile.name")} htmlFor="name"><input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={120} /></Field>
            <button className="btn-primary" disabled={busy || name.trim().length < 2 || name.trim() === me.data?.display_name}>{busy ? <><Spinner />{t("common.saving")}</> : t("common.save")}</button>
          </form>
        )}
      </Card>
    </>
  );
}
