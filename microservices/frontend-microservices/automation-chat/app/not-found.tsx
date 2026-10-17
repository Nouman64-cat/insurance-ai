"use client";

import { useEffect, useState } from "react";
import { pageUrl } from "@/lib/portal";

/**
 * The copilot serves only its own chat. A page path that lands here ("/case/<id>", "/admin/users", typed or from an
 * older chat link) belongs to the Underwriting Workbench or the portal, so forward it there instead of showing a 404.
 */
export default function NotFound() {
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    const { pathname, search, hash } = window.location;
    const url = pageUrl(`${pathname}${search}${hash}`);
    setTarget(url);
    window.location.replace(url);
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-white p-6 text-center">
      <div className="space-y-2">
        <p className="text-sm font-medium text-slate-700">Opening this page where it lives…</p>
        {target && (
          <a href={target} className="text-sm font-semibold text-blue-600 hover:underline">
            Continue
          </a>
        )}
      </div>
    </main>
  );
}
