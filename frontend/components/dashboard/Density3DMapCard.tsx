"use client";

import dynamic from "next/dynamic";

export const Density3DMapCard = dynamic(
  () => import("./Density3DMapCardImpl").then((mod) => mod.Density3DMapCardImpl),
  {
    ssr: false,
    loading: () => (
      <div className="bg-white rounded-xl border border-slate-200 shadow-card flex items-center justify-center min-h-[420px] text-xs text-slate-400 font-semibold">
        Loading 3D density map…
      </div>
    ),
  }
);
