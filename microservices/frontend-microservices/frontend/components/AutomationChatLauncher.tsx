"use client";

import { useEffect, useRef, useState } from "react";
import { AUTOMATION_URL } from "@/lib/appLinks";
import { tx } from "@/lib/i18n/tx";
import { currentCopilotIdentity } from "@/lib/copilotName";
import CopilotRoleIcon from "@/components/CopilotRoleIcon";

/** The automation app owns chat, history, APIs and SSO; the portal only owns this window. */
export default function AutomationChatLauncher() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  // Named for the signed-in role (Claims Copilot, Medical Underwriting Copilot…); read after mount to match SSR.
  const [identity, setIdentity] = useState({ name: "GetInsuredAI Copilot", tagline: "Your insurance assistant" });
  useEffect(() => { setIdentity(currentCopilotIdentity()); }, []);
  const frame = useRef<HTMLIFrameElement>(null);
  const [slow, setSlow] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); launcher.current?.focus(); };
  useEffect(() => {
    if (!mounted || loaded) return;
    const timer = window.setTimeout(() => setSlow(true), 12000);
    return () => window.clearTimeout(timer);
  }, [mounted, loaded]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== new URL(AUTOMATION_URL).origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "automation-chat:status" && typeof event.data.busy === "boolean") setBusy(event.data.busy);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  return <>
    {mounted && <section id="automation-chat-window" role="dialog" aria-label={tx(identity.name)} hidden={!open}
      className={`${open ? "flex" : "hidden"} fixed bottom-24 right-4 z-40 h-[min(820px,calc(100dvh-130px))] w-[calc(100vw-32px)] max-w-[600px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_20px_70px_-15px_rgba(15,23,42,0.3)] sm:right-6`}>
      <header className="flex shrink-0 items-center justify-between border-b border-slate-100 bg-white px-4 py-3">
        <div className="flex items-center gap-2.5"><CopilotRoleIcon name={identity.name} /><div><h2 className="text-sm font-semibold text-slate-900">{tx(identity.name)}</h2><p className="text-[11px] text-slate-400">{tx(identity.tagline)}</p></div></div>
        <div className="flex items-center gap-1"><button type="button" onClick={close} className="rounded-lg px-2 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100">{tx("Back to portal")}</button><a href={AUTOMATION_URL} target="_blank" rel="noopener noreferrer" aria-disabled={busy} onClick={event => {if (busy) event.preventDefault(); else close();}} title={tx(busy ? "Wait for the current response before expanding" : "Open full Copilot in a new tab")} aria-label={tx("Open full Copilot in a new tab")} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 focus-visible:outline-blue-600"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" /></svg></a><button type="button" onClick={close} aria-label={tx("Minimize Copilot")} title={tx("Minimize Copilot")} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 focus-visible:outline-blue-600"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true"><path d="M5 12h14" /></svg></button></div>
      </header>
      <div className="relative min-h-0 flex-1">
        {!loaded && <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-50 p-6 text-center text-sm text-slate-500"><span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-200 border-t-blue-600" />{tx(slow ? "Copilot is taking longer to load." : "Opening your Copilot…")}{slow && <a href={AUTOMATION_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-600">{tx("Open full Copilot")}</a>}</div>}
        <iframe ref={frame} src={`${AUTOMATION_URL}/embed`} title={`${tx(identity.name)} — ${tx("conversation")}`} onLoad={() => setLoaded(true)} className={`h-full w-full border-0 ${loaded ? "" : "invisible"}`} />
      </div>
    </section>}
    <button ref={launcher} type="button" aria-label={`${tx(open ? "Minimize" : "Open")} ${tx(identity.name)}`} aria-expanded={open} aria-controls="automation-chat-window"
      onClick={() => { if (open) close(); else {setMounted(true);setOpen(true);} }}
      className="fixed bottom-6 right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg shadow-blue-600/25 transition hover:-translate-y-0.5 hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-600 sm:right-6">
      <CopilotRoleIcon name={identity.name} />
    </button>
  </>;
}
