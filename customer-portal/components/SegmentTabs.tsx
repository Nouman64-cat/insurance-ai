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
  const icon = { individual: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0", family: "M17 20h5v-2a4 4 0 0 0-3-3.87M9 20H4v-2a4 4 0 0 1 3-3.87m6-3.13a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" };
  return (
    <div role="group" aria-label={t("segment.label")} className="mb-4 inline-flex rounded-2xl border border-slate-200 bg-slate-100/80 p-1">
      {(["individual", "family"] as const).map((s) => (
        <button key={s} type="button" aria-pressed={segment === s} onClick={() => onChange(s)}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition-all ${segment === s ? "bg-white text-blue-700 shadow-sm ring-1 ring-blue-100" : "text-slate-500 hover:text-slate-800"}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true"><path d={icon[s]} /></svg>
          {t(`segment.${s}`)}
        </button>
      ))}
    </div>
  );
}
