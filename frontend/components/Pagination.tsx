"use client";

import { useEffect, useMemo, useState } from "react";

/** Rows per page — the same as the Leads board. */
export const DEFAULT_PAGE_SIZE = 12;

export interface PaginationState {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  setPage: (page: number) => void;
}

/**
 * Client-side paging for a list that is already loaded (and already filtered / sorted).
 * Returns the rows for the current page plus the props <Pagination> needs.
 *
 * The page goes back to 1 whenever the list changes size — a new search, filter or
 * tab — and is clamped if the list shrinks (e.g. after deleting the last row on the
 * last page), so you are never left on an empty page.
 */
export function usePagination<T>(items: readonly T[], pageSize: number = DEFAULT_PAGE_SIZE, resetKey?: unknown) {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const [page, setPageRaw] = useState(1);

  useEffect(() => {
    setPageRaw(1);
  }, [totalItems, resetKey]);

  const current = Math.min(page, totalPages);
  const pageItems = useMemo(
    () => items.slice((current - 1) * pageSize, current * pageSize),
    [items, current, pageSize]
  );

  const state: PaginationState = {
    page: current,
    totalPages,
    totalItems,
    pageSize,
    setPage: (p) => setPageRaw(Math.min(Math.max(1, p), totalPages)),
  };
  return { pageItems, pagination: state };
}

/**
 * The footer used across the portal: "Showing 1-12 of 118 leads  ·  Previous  Page 1 of 10  Next".
 * Renders nothing for an empty list.
 */
export function Pagination({
  pagination,
  noun = "items",
  className = "",
  inline = false,
}: {
  pagination: PaginationState;
  /** Plural noun for what is listed ("leads", "users", "policies"…). */
  noun?: string;
  className?: string;
  /** Render as the bottom bar of a table card instead of a card of its own. */
  inline?: boolean;
}) {
  const { page, totalPages, totalItems, pageSize, setPage } = pagination;
  if (totalItems === 0) return null;
  const from = Math.min(totalItems, (page - 1) * pageSize + 1);
  const to = Math.min(totalItems, page * pageSize);
  const btn =
    "px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm";
  return (
    <div
      className={`bg-slate-50 px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-4 w-full ${
        inline ? "border-t border-slate-200" : "border border-slate-200 rounded-xl shadow-sm"
      } ${className}`}
    >
      <div className="text-xs text-slate-500">
        Showing <span className="font-semibold text-slate-700">{from}-{to}</span> of{" "}
        <span className="font-semibold text-slate-700">{totalItems}</span> {noun}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setPage(page - 1)} disabled={page === 1} className={btn}>
          Previous
        </button>
        <div className="text-xs font-semibold text-slate-700 px-2">
          Page {page} of {totalPages}
        </div>
        <button type="button" onClick={() => setPage(page + 1)} disabled={page === totalPages} className={btn}>
          Next
        </button>
      </div>
    </div>
  );
}
