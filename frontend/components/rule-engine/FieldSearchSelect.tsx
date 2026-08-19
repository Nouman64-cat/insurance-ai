"use client";

import React, { useState, useRef, useEffect } from "react";
import { GROUPED_FIELDS, FIELD_LABELS } from "./constants";

interface Props {
  value: string;
  onChange: (val: string) => void;
}

export default function FieldSearchSelect({ value, onChange }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectedLabel = FIELD_LABELS[value] || value || "Select Evaluation Field";

  // Filter fields based on search query
  const filteredGroups = GROUPED_FIELDS.map((g) => {
    const matchingFields = g.fields.filter(
      (f) =>
        f.code.toLowerCase().includes(search.toLowerCase()) ||
        f.label.toLowerCase().includes(search.toLowerCase())
    );
    return { ...g, fields: matchingFields };
  }).filter((g) => g.fields.length > 0);

  return (
    <div ref={containerRef} className="relative flex-1 min-w-[180px]">
      {/* Selector Trigger Button */}
      <button
        type="button"
        onClick={() => {
          setIsOpen((prev) => !prev);
          setSearch("");
        }}
        className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-left font-semibold text-slate-800 hover:border-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
      >
        <span className="truncate">
          {value ? (
            <span className="flex items-center gap-1.5 truncate">
              <span className="text-slate-900 font-bold">{selectedLabel}</span>
              <code className="text-[10px] text-slate-400 font-mono">({value})</code>
            </span>
          ) : (
            <span className="text-slate-400 italic">Select Field...</span>
          )}
        </span>
        <svg
          className={`w-3.5 h-3.5 text-slate-400 shrink-0 transition-transform ${isOpen ? "rotate-180 text-blue-600" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Floating Searchable Menu */}
      {isOpen && (
        <div className="absolute left-0 top-full mt-1 z-50 w-72 max-h-64 bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden flex flex-col">
          {/* Search Box Header */}
          <div className="p-2 border-b border-slate-100 bg-slate-50 shrink-0">
            <div className="relative">
              <svg className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search field or keyword (e.g. age, bmi, smoker)..."
                className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 font-medium"
              />
            </div>
          </div>

          {/* Grouped Keyword List */}
          <div className="flex-1 overflow-y-auto p-1 divide-y divide-slate-100">
            {filteredGroups.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-400 italic">
                No matching field found.
                {search && (
                  <button
                    type="button"
                    onClick={() => {
                      onChange(search.toLowerCase().trim());
                      setIsOpen(false);
                    }}
                    className="block mt-1 mx-auto text-blue-600 font-bold hover:underline"
                  >
                    Use custom keyword: &quot;{search}&quot;
                  </button>
                )}
              </div>
            ) : (
              filteredGroups.map((g) => (
                <div key={g.group} className="py-1">
                  <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    {g.group}
                  </div>
                  {g.fields.map((f) => {
                    const isSelected = value === f.code;
                    return (
                      <button
                        key={f.code}
                        type="button"
                        onClick={() => {
                          onChange(f.code);
                          setIsOpen(false);
                        }}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left text-xs transition cursor-pointer ${
                          isSelected
                            ? "bg-blue-50 text-blue-900 font-bold"
                            : "hover:bg-slate-50 text-slate-700"
                        }`}
                      >
                        <span className="truncate leading-snug">{f.label.split(" (")[0]}</span>
                        <code className="text-[10px] font-mono text-slate-400 ml-2 shrink-0">{f.code}</code>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
