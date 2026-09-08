"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { globalSearch, type SearchResult, type SearchResultType } from "@/app/services/search";

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg className="animate-spin w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// Order groups appear in the dropdown + their headings.
const GROUPS: { type: SearchResultType; label: string }[] = [
  { type: "case", label: "Cases" },
  { type: "customer", label: "Customers" },
  { type: "policy", label: "Policies" },
  { type: "claim", label: "Claims" },
];

const DEBOUNCE_MS = 250;
const MIN_CHARS = 2;

export default function GlobalSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);

  // ── Grouped + flattened views of the results ────────────────────────────────
  const grouped = useMemo(
    () => GROUPS.map((g) => ({ ...g, items: results.filter((r) => r.type === g.type) })).filter((g) => g.items.length > 0),
    [results],
  );
  const flat = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);

  // ── Debounced query → API ──────────────────────────────────────────────────
  useEffect(() => {
    const term = query.trim();
    if (term.length < MIN_CHARS) {
      setResults([]);
      setLoading(false);
      return;
    }

    const tenantId = typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";
    if (!tenantId) return;

    const seq = ++seqRef.current;
    const controller = new AbortController();
    setLoading(true);

    const timer = setTimeout(() => {
      globalSearch(tenantId, term, controller.signal)
        .then((hits) => {
          if (seq !== seqRef.current) return; // a newer query already fired
          setResults(hits);
          setActiveIndex(0);
          setOpen(true);
        })
        .catch(() => {
          if (seq !== seqRef.current) return;
          setResults([]);
        })
        .finally(() => {
          if (seq === seqRef.current) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  // ── Close on click outside ─────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // ── Global focus shortcuts: ⌘K / Ctrl+K, and "/" ──────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        return;
      }
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const go = useCallback(
    (result: SearchResult) => {
      setOpen(false);
      setQuery("");
      setResults([]);
      inputRef.current?.blur();
      router.push(result.url);
    },
    [router],
  );

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!open || flat.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = flat[activeIndex];
      if (pick) go(pick);
    }
  };

  const term = query.trim();
  const showPanel = open && term.length >= MIN_CHARS;

  return (
    <div ref={rootRef} className="hidden md:flex flex-1 max-w-xs relative">
      <div className="relative w-full">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
          {loading ? <SpinnerIcon /> : <SearchIcon />}
        </span>
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => term.length >= MIN_CHARS && setOpen(true)}
          onKeyDown={onInputKeyDown}
          placeholder="Search cases, policies…"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls="global-search-results"
          className="w-full pl-9 pr-4 py-1.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-all"
        />
      </div>

      {showPanel && (
        <div
          id="global-search-results"
          role="listbox"
          className="absolute top-full left-0 right-0 mt-2 max-h-[70vh] overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-lg shadow-slate-900/5 py-1.5 z-50"
        >
          {flat.length === 0 && !loading && (
            <p className="px-3 py-4 text-xs text-slate-400 text-center">
              No matches for “{term}”
            </p>
          )}

          {grouped.map((group) => (
            <div key={group.type} className="py-1">
              <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
                {group.label}
              </p>
              {group.items.map((item) => {
                const idx = flat.indexOf(item);
                return (
                  <button
                    key={`${item.type}-${item.id}`}
                    type="button"
                    role="option"
                    aria-selected={idx === activeIndex}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => go(item)}
                    className={`w-full text-left px-3 py-1.5 flex flex-col gap-0.5 transition-colors ${
                      idx === activeIndex ? "bg-blue-50" : "hover:bg-slate-50"
                    }`}
                  >
                    <span className="text-sm font-semibold text-slate-800 truncate">{item.title}</span>
                    {item.subtitle && (
                      <span className="text-xs text-slate-500 truncate">{item.subtitle}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
