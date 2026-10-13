"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useFamilies } from "@/lib/family";

export type Segment = "individual" | "family";

/** Individual / Family switch for the pages that exist for both (policies, payments, claims, documents). It renders nothing for
 *  a customer without family policies, so the individual experience is exactly what it was. The choice lives in the URL. */
export function useSegment(): [Segment, (s: Segment) => void, boolean] {
  const { has } = useFamilies();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const segment: Segment = has && params.get("segment") === "family" ? "family" : "individual";
  const set = (s: Segment) => {
    const q = new URLSearchParams(params.toString());
    if (s === "family") q.set("segment", "family"); else q.delete("segment");
    router.replace(q.toString() ? `${pathname}?${q}` : pathname);
  };
  return [segment, set, has];
}

export function SegmentTabs({ segment, onChange }: { segment: Segment; onChange: (s: Segment) => void }) {
  const { t } = useI18n();
  return (
    <div role="group" aria-label={t("segment.label")} className="inline-flex rounded-xl border border-slate-200 bg-white p-0.5 mb-4">
      {(["individual", "family"] as const).map((s) => (
        <button key={s} type="button" aria-pressed={segment === s} onClick={() => onChange(s)}
          className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${segment === s ? "bg-blue-600 text-white" : "text-slate-600 hover:text-slate-900"}`}>{t(`segment.${s}`)}</button>
      ))}
    </div>
  );
}
