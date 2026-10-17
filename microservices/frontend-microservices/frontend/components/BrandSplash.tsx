import type { ReactNode } from "react";

/** Shared light splash for session validation and initial page loading. */
export default function BrandSplash({ message = "Loading your workspace…", fullScreen = true, logoSrc = "/logo-full.png", loading = true, children }: { message?: string; fullScreen?: boolean; logoSrc?: string; loading?: boolean; children?: ReactNode }) {
  return <div role="status" aria-live="polite" aria-busy={loading} className={`flex ${fullScreen ? "min-h-[100dvh]" : "h-full min-h-[240px]"} w-full flex-col items-center justify-center bg-[#fafafa] px-6 font-sans`}>
    <div className="flex w-full max-w-sm flex-col items-center text-center">
      <img src={logoSrc} alt="GetInsuredAI, powered by Rizviz" width={300} height={100} fetchPriority="high" className="h-auto w-64 max-w-full object-contain sm:w-72" />
      <div className="mt-9 flex items-center gap-2.5 text-sm text-zinc-500">
        {loading && <span aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none rounded-full border-2 border-blue-100 border-t-blue-400" />}
        <span>{message}</span>
      </div>
      {children}
    </div>
  </div>;
}
