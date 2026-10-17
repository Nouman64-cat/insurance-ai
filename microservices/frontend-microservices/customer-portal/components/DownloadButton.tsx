"use client";
import { useState } from "react";
import { download } from "@/lib/api";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Icon, Spinner, errorText, useToast } from "./ui";

export function DownloadButton({ handle, fallbackName, label, available = true }: { handle: string; fallbackName: string; label?: string; available?: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!available) return <span className="text-xs text-slate-400">{t("documents.unavailable")}</span>;
  return (
    <button type="button" disabled={busy} onClick={async () => {
      setBusy(true);
      try { await download(`documents/download?handle=${encodeURIComponent(handle)}`, fallbackName); }
      catch (e) { toast(errorText(t, e as Error), "error"); }
      finally { setBusy(false); }
    }} className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-50">
      {busy ? <Spinner className="w-3.5 h-3.5" /> : <Icon name="download" className="w-4 h-4" />}{label || t("common.download")}
    </button>
  );
}
