"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { ADMIN_TOUR_STEPS, fillLead, type TourContext } from "@/lib/tour/adminTour";
import { TOUR_LEAD_EVENT, type TourLead } from "@/lib/tour/events";
import { tx } from "@/lib/i18n/tx";
import { isUnderwritingPath } from "@/lib/appLinks";

// Welcome tour for an Admin's first sign-in. The login page sets `tour_pending` (to the user's email) when the
// server says it was their first ever sign-in.
//
// The page stays fully usable while the tour is open: the dimmed backdrop and the ring only draw, they never
// block clicks. Each step spotlights the area to use and, for the steps that need a real action, waits for it
// (a lead saved, a proposal sent to underwriting) and moves on by itself. The lead created in step 2 is
// remembered and highlighted on the pages after it. Finishing or skipping clears the flag, so the tour never
// returns on its own; "Take the tour" in the top bar replays it.

export const TOUR_PENDING_KEY = "tour_pending";
export const TOUR_START_EVENT = "start-admin-tour";
const TOUR_LEAD_KEY = "tour_lead";

const CARD_W = 380;
const PAD = 6;

interface Box { top: number; left: number; width: number; height: number }

const readLead = (): TourLead | null => {
  try {
    const raw = sessionStorage.getItem(TOUR_LEAD_KEY);
    return raw ? (JSON.parse(raw) as TourLead) : null;
  } catch { return null; }
};

export default function AdminTour() {
  const router = useRouter();
  const pathname = usePathname();
  const steps = ADMIN_TOUR_STEPS;

  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  const [lead, setLead] = useState<TourLead | null>(null);
  const [doneNote, setDoneNote] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [cardH, setCardH] = useState(360);
  const [vp, setVp] = useState({ w: 1280, h: 800 });
  const cardRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const foundRef = useRef(false);
  const openedStep = useRef(-1);
  const advanceTimer = useRef<number | null>(null);

  const step = steps[index];
  const ctx: TourContext = { lead };

  const clearAdvance = () => {
    if (advanceTimer.current) window.clearTimeout(advanceTimer.current);
    advanceTimer.current = null;
  };

  const finish = useCallback(() => {
    clearAdvance();
    try {
      localStorage.removeItem(TOUR_PENDING_KEY);
      sessionStorage.removeItem(TOUR_LEAD_KEY);
    } catch { /* storage unavailable */ }
    setActive(false);
    setBox(null);
    setLead(null);
    setDoneNote(null);
    started.current = false;
    openedStep.current = -1;
  }, []);

  const goTo = useCallback((i: number) => {
    clearAdvance();
    setDoneNote(null);
    setHint(null);
    setIndex(Math.max(0, Math.min(i, steps.length - 1)));
  }, [steps.length]);

  const begin = useCallback(() => {
    started.current = true;
    openedStep.current = -1;
    setLead(readLead());
    setDoneNote(null);
    setIndex(0);
    setActive(true);
  }, []);

  // First sign-in: the login page left a flag for this Admin. Wait a moment for the page to settle.
  useEffect(() => {
    if (started.current) return;
    let pending: string | null = null;
    let role: string | null = null;
    let email: string | null = null;
    try {
      pending = localStorage.getItem(TOUR_PENDING_KEY);
      role = localStorage.getItem("user_role");
      email = localStorage.getItem("user_email");
    } catch { return; }
    if (role !== "Admin" || !pending || pending !== email) return;
    const t = window.setTimeout(begin, 1200);
    return () => window.clearTimeout(t);
  }, [pathname, begin]);

  // Replay from the top bar.
  useEffect(() => {
    const onStart = () => {
      if (localStorage.getItem("user_role") === "Admin") {
        try { sessionStorage.removeItem(TOUR_LEAD_KEY); } catch { /* ignore */ }
        begin();
      }
    };
    window.addEventListener(TOUR_START_EVENT, onStart);
    return () => window.removeEventListener(TOUR_START_EVENT, onStart);
  }, [begin]);

  // Warm every page the tour visits, once, in the background. The first visit to a page is the slow part of a
  // step (the dev server compiles it on demand; production still has to fetch its code), so by the time the
  // Admin presses Next the page is ready. One at a time and after a pause, so it never competes with the
  // page they are looking at.
  const warmed = useRef(false);
  useEffect(() => {
    if (!active || warmed.current) return;
    warmed.current = true;
    let cancelled = false;
    // Step 1's page is already open; start with the page the Admin will reach next.
    // Workbench pages are another app: the portal's router can't prefetch them.
    const routes = Array.from(new Set(steps.map((st) => st.route))).slice(1).filter((r) => !isUnderwritingPath(r));
    (async () => {
      await new Promise((r) => window.setTimeout(r, 100));
      for (const route of routes) {
        if (cancelled) return;
        try { router.prefetch(route); } catch { /* ignore */ }
        try { await fetch(route, { credentials: "same-origin", headers: { "x-tour-warm": "1" }, cache: "no-store" }); } catch { /* offline: skip */ }
      }
    })();
    return () => { cancelled = true; };
  }, [active, steps, router]);

  // Open the step's page once, when the step starts. After that the Admin is free to click around.
  useEffect(() => {
    if (!active || !step || openedStep.current === index) return;
    openedStep.current = index;
    // A workbench step stays on the current page and points at the sidebar link, which opens the workbench.
    if (pathname !== step.route && !isUnderwritingPath(step.route)) router.push(step.route);
  }, [active, step, index, pathname, router]);

  // A lead was saved: remember it, and if this step was waiting for it, move on.
  useEffect(() => {
    if (!active) return;
    const onLead = (e: Event) => {
      const l = (e as CustomEvent<TourLead>).detail;
      if (!l) return;
      try { sessionStorage.setItem(TOUR_LEAD_KEY, JSON.stringify(l)); } catch { /* ignore */ }
      setLead(l);
      if (steps[index]?.advanceOnLead) {
        setDoneNote(steps[index].doneNote ?? "Done.");
        clearAdvance();
        advanceTimer.current = window.setTimeout(() => goTo(index + 1), steps[index].advanceDelayMs ?? 1500);
      }
    };
    window.addEventListener(TOUR_LEAD_EVENT, onLead);
    return () => window.removeEventListener(TOUR_LEAD_EVENT, onLead);
  }, [active, index, steps, goTo]);

  // A step finished by something the Admin did on the page (e.g. sending the proposal to underwriting).
  useEffect(() => {
    if (!active || !step?.doneWhen || doneNote) return;
    if (!step.doneWhen({ lead }, pathname)) return;
    setDoneNote(step.doneNote ?? "Done.");
    clearAdvance();
    advanceTimer.current = window.setTimeout(() => goTo(index + 1), step.advanceDelayMs ?? 1500);
  }, [active, step, pathname, lead, doneNote, index, goTo]);

  // Follow the area this step is about: the page area when it can be found, else the sidebar link. Checked a few
  // times a second so it also tracks a dialog opening or a list filling in. Kept deliberately light, because the
  // pages behind it can be big: no dimming layer to repaint, scroll handling throttled to one frame, and state
  // only updated when something actually changed.
  useEffect(() => {
    if (!active || !step) return;
    let lastEl: HTMLElement | null = null;
    let frame = 0;
    const targets = (): HTMLElement[] => {
      const area = step.find?.({ lead }) ?? [];
      if (area.length) return area;
      const link = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
      return link ? [link] : [];
    };
    const measure = () => {
      frame = 0;
      setVp((v) => (v.w === window.innerWidth && v.h === window.innerHeight ? v : { w: window.innerWidth, h: window.innerHeight }));
      if (step.hint) {
        const h = step.hint({ lead });
        setHint((cur) => (cur === h ? cur : h));
      }
      const els = targets();
      foundRef.current = els.length > 0;
      if (!els.length) { setBox((b) => (b ? null : b)); return; }
      const rects = els.map((el) => el.getBoundingClientRect());
      const top = Math.min(...rects.map((r) => r.top));
      const left = Math.min(...rects.map((r) => r.left));
      const right = Math.max(...rects.map((r) => r.right));
      const bottom = Math.max(...rects.map((r) => r.bottom));
      // Bring a new target into view once (a dialog's buttons can sit below the fold); never fight the Admin's own scrolling.
      if (els[0] !== lastEl) {
        lastEl = els[0];
        if (top < 60 || bottom > window.innerHeight - 20) els[0].scrollIntoView({ block: "center", behavior: "smooth" });
      }
      const next = { top: Math.round(top), left: Math.round(left), width: Math.round(right - left), height: Math.round(bottom - top) };
      setBox((b) => (b && b.top === next.top && b.left === next.left && b.width === next.width && b.height === next.height ? b : next));
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(measure); };
    // Look quickly while the step's page is loading (so the ring lands the moment the area appears), then
    // settle to a relaxed pace once it has been found.
    const startedAt = performance.now();
    let timerId = 0;
    const tick = () => {
      schedule();
      const fast = !foundRef.current || performance.now() - startedAt < 1500;
      timerId = window.setTimeout(tick, fast ? 70 : 400);
    };
    tick();
    const timer = { clear: () => window.clearTimeout(timerId) };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      timer.clear();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, { capture: true } as EventListenerOptions);
    };
  }, [active, step, lead, pathname]);

  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight);
  }, [index, active, box, doneNote, hint]);

  // Keyboard: arrows move, Escape skips (not while typing in a form).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (typing) return;
      if (e.key === "Escape") finish();
      else if (e.key === "ArrowRight") goTo(index + 1);
      else if (e.key === "ArrowLeft") goTo(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, finish, goTo, index]);

  useEffect(() => () => clearAdvance(), []);

  if (!active || !step || typeof document === "undefined") return null;

  const last = index === steps.length - 1;

  // Beside the spotlighted area, wherever there is room: below it, to its right, to its left, or above it.
  const cardStyle: React.CSSProperties = (() => {
    const GAP = 16;
    if (!box) return { left: Math.max(12, (vp.w - CARD_W) / 2), top: Math.max(12, (vp.h - cardH) / 2), width: CARD_W };
    const clampX = (x: number) => Math.max(12, Math.min(x, vp.w - CARD_W - 12));
    const clampY = (y: number) => Math.max(12, Math.min(y, vp.h - cardH - 12));
    const below = box.top + box.height + PAD + GAP;
    const above = box.top - PAD - GAP - cardH;
    const spaceRight = vp.w - (box.left + box.width + PAD) - GAP - 12;
    const spaceLeft = box.left - PAD - GAP - 12;
    if (below + cardH <= vp.h - 12) return { left: clampX(box.left + box.width - CARD_W), top: below, width: CARD_W };
    if (spaceRight >= CARD_W) return { left: box.left + box.width + PAD + GAP, top: clampY(box.top - 8), width: CARD_W };
    if (spaceLeft >= CARD_W) return { left: box.left - PAD - GAP - CARD_W, top: clampY(box.top - 8), width: CARD_W };
    if (above >= 12) return { left: clampX(box.left), top: above, width: CARD_W };
    return { left: Math.max(12, (vp.w - CARD_W) / 2), top: clampY(vp.h - cardH - 24), width: CARD_W };
  })();

  return createPortal(
    <>
      {/* The ring only draws: clicks go straight through to the page. No full-screen dimming, which made the page
          behind repaint on every move. */}
      {box && (
        <div
          aria-hidden="true"
          data-tour-ui
          className="pointer-events-none fixed z-[9998] rounded-xl"
          style={{
            top: box.top - PAD,
            left: box.left - PAD,
            width: box.width + PAD * 2,
            height: box.height + PAD * 2,
            boxShadow: "0 0 0 3px #3b82f6, 0 0 0 7px rgba(59, 130, 246, 0.25)",
            transition: "top 200ms ease, left 200ms ease, width 200ms ease, height 200ms ease",
          }}
        />
      )}

      <div
        ref={cardRef}
        data-tour-ui
        role="dialog"
        aria-label={tx("Tour step {0} of {1}: {2}", { 0: index + 1, 1: steps.length, 2: fillLead(step.title, ctx) })}
        className="fixed z-[9999] rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"
        style={cardStyle}
      >
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold uppercase tracking-widest text-blue-600">
            {tx("Step")}{" "}{index + 1}{" "}{tx("of")}{" "}{steps.length}
          </span>
          <button type="button" onClick={finish} className="text-xs font-semibold text-slate-400 hover:text-slate-600">
            {tx("Skip tour")}
          </button>
        </div>

        <h3 className="mt-2 text-lg font-bold tracking-tight text-slate-900">{fillLead(step.title, ctx)}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{fillLead(step.summary, ctx)}</p>

        <p className="mt-4 text-[11px] font-bold uppercase tracking-widest text-slate-400">{tx("What to do here")}</p>
        <ol className="mt-1.5 space-y-1.5">
          {step.todo.map((t, i) => (
            <li key={t} className="flex gap-2.5 text-[13px] leading-snug text-slate-700">
              <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-blue-50 text-[10px] font-bold text-blue-700">
                {i + 1}
              </span>
              {fillLead(t, ctx)}
            </li>
          ))}
        </ol>

        {hint && !doneNote && (
          <p className="mt-4 rounded-lg border border-blue-200 bg-blue-50/60 px-3 py-2 text-[13px] font-semibold leading-snug text-blue-800">
            {hint}
          </p>
        )}

        {(step.waitHint || doneNote) && (
          <div
            className={`mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold ${
              doneNote ? "bg-emerald-50 text-emerald-700" : "bg-blue-50 text-blue-700"
            }`}
            role="status"
          >
            {doneNote ? (
              <span aria-hidden="true">✓</span>
            ) : (
              <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
            )}
            {doneNote ?? step.waitHint}
          </div>
        )}

        <div className="mt-5 flex items-center justify-between">
          <div className="flex gap-1" aria-hidden="true">
            {steps.map((s, i) => (
              <span key={s.id} className={`h-1.5 rounded-full transition-all ${i === index ? "w-5 bg-blue-600" : "w-1.5 bg-slate-200"}`} />
            ))}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => goTo(index - 1)}
              disabled={index === 0}
              className="rounded-lg border border-slate-200 px-3.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              {tx("Previous")}
            </button>
            <button
              type="button"
              onClick={() => (last ? finish() : goTo(index + 1))}
              className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
            >
              {last ? tx("Finish") : step.waitHint && !doneNote ? tx("Skip step") : tx("Next")}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}
