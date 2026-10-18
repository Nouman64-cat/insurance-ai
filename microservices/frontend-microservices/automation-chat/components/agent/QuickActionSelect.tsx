"use client";

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { QuickAction } from "@/lib/agent/types";
import { QuickActionDate } from "./QuickActionDate";

// ── Option labels arrive as one sentence from chat-agent, e.g.
//    "PL-2026-0006 — Ahmed Malik (Salary Protection Plan, cover PKR 10,500,000)".
// Split them into reference / title / details / amount for display only — the
// value that is submitted is always the untouched option value.

type ParsedOption = {
  value: string;
  label: string;
  reference?: string;
  title: string;
  details: string[];
  amount?: string;
  amountShort?: string;
  amountCaption?: string;
};

const REFERENCE = /^[A-Z]{2,}[-/][A-Z0-9-/]+$/i;
const MONEY = /^(?:cover\s+|sum assured\s+)?(PKR|Rs\.?)\s*([\d,]+(?:\.\d+)?)$/i;

function compactMoney(currency: string, digits: string): string {
  const n = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(n)) return `${currency} ${digits}`;
  const fmt = (v: number, s: string) => `${currency} ${v.toFixed(v < 100 ? 1 : 0).replace(/\.0$/, "")}${s}`;
  if (n >= 1e9) return fmt(n / 1e9, "B");
  if (n >= 1e6) return fmt(n / 1e6, "M");
  if (n >= 1e3) return fmt(n / 1e3, "K");
  return `${currency} ${n.toLocaleString()}`;
}

function parseOption(opt: { label: string; value: string }): ParsedOption {
  let rest = opt.label.trim();
  let reference: string | undefined;
  const dash = rest.match(/^(\S+)\s+[—–-]\s+(.+)$/);
  if (dash && REFERENCE.test(dash[1])) {
    reference = dash[1];
    rest = dash[2];
  }
  let details: string[] = [];
  const paren = rest.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (paren && paren[1]) {
    rest = paren[1];
    details = paren[2].split(/,\s+/).map((d) => d.trim()).filter(Boolean);
  }
  let amount: string | undefined;
  let amountShort: string | undefined;
  let amountCaption: string | undefined;
  details = details.filter((d) => {
    const m = d.match(MONEY);
    if (m && !amount) {
      amount = d.replace(/^(cover|sum assured)\s+/i, "");
      amountShort = compactMoney(m[1].toUpperCase().startsWith("RS") ? "Rs" : "PKR", m[2]);
      amountCaption = d.match(/^(cover|sum assured)\s/i)?.[1];
      return false;
    }
    return true;
  });
  return { value: opt.value, label: opt.label, reference, title: rest, details, amount, amountShort, amountCaption };
}

const AVATAR_TONES = [
  "from-blue-500 to-indigo-500",
  "from-violet-500 to-fuchsia-500",
  "from-emerald-500 to-teal-500",
  "from-amber-500 to-orange-500",
  "from-rose-500 to-pink-500",
  "from-sky-500 to-cyan-500",
];

function initials(text: string): string {
  const words = text.replace(/[^A-Za-z\u00C0-\u024F\u0600-\u06FF\s]/g, "").split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "•";
}

function tone(text: string): string {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-[3px] bg-amber-100 px-0.5 text-inherit">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

const Icon = {
  search: (cls: string) => (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" />
    </svg>
  ),
  chevron: (cls: string) => (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  ),
  check: (cls: string) => (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.6}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  ),
  close: (cls: string) => (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  ),
  list: (cls: string) => (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  ),
};

type InlineInputProps = {
  action: QuickAction;
  onRun: (text: string) => void;
  variant?: "chip" | "card";
  // The persisted answer, when the parent keeps one (see AgentMessage.selections).
  selectedLabel?: string;
  onSelected?: (label: string) => void;
};

// The quick actions that take an answer inline rather than acting on click.
export const isInlineInput = (action: QuickAction): boolean =>
  action.actionType === "select" || action.actionType === "date";

export function QuickActionSelect(props: InlineInputProps) {
  return props.action.actionType === "date" ? <QuickActionDate {...props} /> : <OptionSelect {...props} />;
}

function OptionSelect({
  action,
  onRun,
  variant = "chip",
  selectedLabel,
  onSelected,
}: InlineInputProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [visible, setVisible] = useState(false); // drives the enter transition
  const [openUp, setOpenUp] = useState(false);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  // Once an option is picked the prompt is answered: show what was chosen and
  // stop accepting input, the same way a clicked chip stays highlighted.
  const [localChosen, setChosen] = useState<string | null>(null);
  const chosen = selectedLabel ?? localChosen;
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const options = action.options ?? [];
  const parsed = useMemo(() => options.map(parseOption), [options]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? parsed.filter((o) => o.label.toLowerCase().includes(q)) : parsed;
  }, [parsed, search]);
  const chosenParsed = useMemo(
    () => (chosen ? parsed.find((o) => o.label === chosen) ?? parseOption({ label: chosen, value: chosen }) : null),
    [chosen, parsed],
  );
  const rich = parsed.some((o) => o.reference || o.details.length || o.amount);
  const noun = (action.label || "option").toLowerCase();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) close();
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Open upward when the composer below would cover the panel.
  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setOpenUp(window.innerHeight - rect.bottom < 380 && rect.top > window.innerHeight - rect.bottom);
    const id = requestAnimationFrame(() => setVisible(true));
    searchInputRef.current?.focus();
    return () => cancelAnimationFrame(id);
  }, [isOpen]);

  useEffect(() => setActive(0), [search]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (options.length === 0) return null;

  function close() {
    setVisible(false);
    setIsOpen(false);
    setSearch("");
  }

  const run = (value: string) => {
    if (!value || chosen !== null) return;
    close();
    const label = options.find((o) => o.value === value)?.label ?? value;
    setChosen(label);
    onSelected?.(label);
    const text = action.payload?.includes("{value}")
      ? action.payload.replace("{value}", value)
      : action.payload || value;
    onRun(text);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[active]) run(filtered[active].value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
      triggerRef.current?.focus();
    }
  };

  if (options.length === 1) {
    return (
      <button
        type="button"
        disabled={chosen !== null}
        onClick={() => run(options[0].value)}
        className={`px-3 py-1.5 text-[12px] font-bold rounded-full border shadow-sm transition-all ${
          chosen !== null
            ? "bg-blue-600 text-white border-blue-600 cursor-default"
            : "bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-200 active:scale-95"
        }`}
      >
        {action.label}: {options[0].label}
      </button>
    );
  }

  const compact = variant === "chip";

  return (
    <div ref={containerRef} className="relative inline-block max-w-full">
      {/* ── Trigger ─────────────────────────────────────────────────────── */}
      <button
        ref={triggerRef}
        type="button"
        disabled={chosen !== null}
        onClick={() => (isOpen ? close() : setIsOpen(true))}
        onKeyDown={(e) => {
          if (!isOpen && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setIsOpen(true);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className={`group flex max-w-full items-center gap-3 rounded-2xl border text-left transition-all duration-200 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/15 ${
          chosen !== null
            ? "cursor-default border-emerald-200 bg-emerald-50/70"
            : isOpen
              ? "border-blue-400 bg-white shadow-[0_0_0_4px_rgba(59,130,246,0.10)]"
              : "border-slate-200 bg-white shadow-sm hover:border-blue-300 hover:shadow-md"
        } ${compact ? "py-1.5 pl-1.5 pr-3" : "py-2 pl-2 pr-4"}`}
      >
        <span
          className={`flex shrink-0 items-center justify-center rounded-xl ${compact ? "h-8 w-8" : "h-9 w-9"} ${
            chosen !== null ? "bg-emerald-500 text-white" : "bg-gradient-to-br from-blue-500 to-indigo-500 text-white shadow-sm"
          }`}
        >
          {chosen !== null ? Icon.check("h-4 w-4") : Icon.list("h-4 w-4")}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`block text-[10px] font-bold uppercase tracking-[0.08em] ${
              chosen !== null ? "text-emerald-700" : "text-blue-600"
            }`}
          >
            {chosen !== null ? `${action.label} selected` : action.label}
          </span>
          <span
            className={`block truncate font-semibold ${compact ? "max-w-[18rem] text-[13px]" : "max-w-[24rem] text-sm"} ${
              chosen !== null ? "text-emerald-900" : "text-slate-500"
            }`}
          >
            {chosenParsed
              ? [chosenParsed.reference, chosenParsed.title].filter(Boolean).join(" · ")
              : action.placeholder || "Choose one…"}
          </span>
        </span>
        {chosen === null && (
          <span className="ml-1 flex items-center gap-2">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
              {options.length}
            </span>
            {Icon.chevron(
              `h-4 w-4 text-slate-400 transition-transform duration-200 group-hover:text-blue-500 ${isOpen ? "rotate-180 text-blue-500" : ""}`,
            )}
          </span>
        )}
      </button>

      {/* ── Panel ───────────────────────────────────────────────────────── */}
      {isOpen && chosen === null && (
        <div
          role="dialog"
          onKeyDown={onKeyDown}
          className={`absolute left-0 z-50 flex w-[min(30rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white/95 shadow-[0_24px_60px_-12px_rgba(15,23,42,0.28)] ring-1 ring-black/[0.02] backdrop-blur-xl transition-all duration-200 ease-out ${
            openUp ? "bottom-full mb-2 origin-bottom-left" : "top-full mt-2 origin-top-left"
          } ${visible ? "translate-y-0 scale-100 opacity-100" : `${openUp ? "translate-y-1" : "-translate-y-1"} scale-[0.98] opacity-0`}`}
        >
          <div className="border-b border-slate-100 p-3">
            <div className="relative">
              {Icon.search("pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400")}
              <input
                ref={searchInputRef}
                type="text"
                role="combobox"
                aria-expanded
                aria-controls="qa-select-list"
                aria-activedescendant={filtered[active] ? `qa-opt-${active}` : undefined}
                placeholder={`Search ${noun}s by name, number…`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-slate-50/80 py-2.5 pl-9 pr-9 text-sm text-slate-800 placeholder:text-slate-400 transition focus:border-blue-400 focus:bg-white focus:outline-none focus:ring-4 focus:ring-blue-500/10"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => {
                    setSearch("");
                    searchInputRef.current?.focus();
                  }}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 hover:bg-slate-200 hover:text-slate-600"
                >
                  {Icon.close("h-3.5 w-3.5")}
                </button>
              )}
            </div>
            <div className="mt-2 flex items-center justify-between px-1 text-[11px] text-slate-400">
              <span>
                {filtered.length === options.length
                  ? `${options.length} ${noun}${options.length === 1 ? "" : "s"}`
                  : `${filtered.length} of ${options.length}`}
              </span>
              <span className="hidden items-center gap-1 sm:flex">
                <kbd className="rounded border border-slate-200 bg-white px-1 font-sans">↑</kbd>
                <kbd className="rounded border border-slate-200 bg-white px-1 font-sans">↓</kbd>
                to move
                <kbd className="ml-1 rounded border border-slate-200 bg-white px-1 font-sans">↵</kbd>
                to select
              </span>
            </div>
          </div>

          <div ref={listRef} id="qa-select-list" role="listbox" className="max-h-[19rem] overflow-y-auto overscroll-contain p-1.5">
            {filtered.length > 0 ? (
              filtered.map((opt, i) => {
                const isActive = i === active;
                return (
                  <button
                    key={opt.value}
                    id={`qa-opt-${i}`}
                    data-index={i}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => run(opt.value)}
                    title={opt.label}
                    className={`group/opt flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors ${
                      isActive ? "bg-blue-50/80" : "hover:bg-slate-50"
                    }`}
                  >
                    {rich && (
                      <span
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${tone(
                          opt.title,
                        )} text-[13px] font-bold text-white shadow-sm`}
                      >
                        {initials(opt.title)}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className={`truncate text-sm font-semibold ${isActive ? "text-blue-700" : "text-slate-800"}`}>
                          <Highlight text={opt.title} query={search} />
                        </span>
                        {opt.reference && (
                          <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-slate-500">
                            <Highlight text={opt.reference} query={search} />
                          </span>
                        )}
                      </span>
                      {opt.details.length > 0 && (
                        <span className="mt-0.5 block truncate text-xs text-slate-500">
                          <Highlight text={opt.details.join(" · ")} query={search} />
                        </span>
                      )}
                    </span>
                    {opt.amountShort && (
                      <span className="shrink-0 text-right">
                        <span className="block text-sm font-bold tabular-nums text-slate-800">{opt.amountShort}</span>
                        {opt.amountCaption && (
                          <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-400">{opt.amountCaption}</span>
                        )}
                      </span>
                    )}
                    {Icon.chevron(
                      `h-4 w-4 shrink-0 -rotate-90 transition-all ${
                        isActive ? "translate-x-0 text-blue-500 opacity-100" : "-translate-x-1 text-slate-300 opacity-0"
                      }`,
                    )}
                  </button>
                );
              })
            ) : (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                  {Icon.search("h-5 w-5")}
                </span>
                <p className="text-sm font-medium text-slate-600">No {noun} matches “{search}”</p>
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="text-xs font-semibold text-blue-600 hover:text-blue-700"
                >
                  Clear search
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
