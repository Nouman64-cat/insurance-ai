"use client";

import React, { useState, useRef, useEffect } from "react";

interface Option {
  code: string;
  label: string;
}

interface Props {
  selected: string[];
  onChange: (items: string[]) => void;
  options: Option[];
  placeholder?: string;
}

export default function MultiTagSelector({ selected = [], onChange, options, placeholder = "Select or type items..." }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputVal, setInputVal] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const toggleItem = (code: string) => {
    if (selected.includes(code)) {
      onChange(selected.filter((item) => item !== code));
    } else {
      onChange([...selected, code]);
    }
  };

  const addItem = (code: string) => {
    const trimmed = code.trim();
    if (trimmed && !selected.includes(trimmed)) {
      onChange([...selected, trimmed]);
    }
    setInputVal("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (inputVal.trim()) {
        addItem(inputVal);
      }
    } else if (e.key === "Backspace" && !inputVal && selected.length > 0) {
      onChange(selected.slice(0, selected.length - 1));
    }
  };

  const filteredOptions = options.filter(
    (o) =>
      o.code.toLowerCase().includes(inputVal.toLowerCase()) ||
      o.label.toLowerCase().includes(inputVal.toLowerCase())
  );

  return (
    <div ref={containerRef} className="relative w-full">
      {/* Selected tags container & text input */}
      <div
        onClick={() => setIsOpen(true)}
        className="w-full flex items-center flex-wrap gap-1.5 p-2 bg-white border border-slate-200 rounded-xl focus-within:ring-1 focus-within:ring-blue-500 focus-within:border-blue-400 min-h-[42px] cursor-text"
      >
        {selected.map((item) => {
          const match = options.find((o) => o.code === item);
          return (
            <span
              key={item}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold bg-blue-50 text-blue-800 border border-blue-200"
            >
              <span>{match ? match.label : item}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleItem(item);
                }}
                className="text-blue-500 hover:text-red-600 transition"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          );
        })}

        <input
          type="text"
          value={inputVal}
          onFocus={() => setIsOpen(true)}
          onChange={(e) => {
            setInputVal(e.target.value);
            setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder={selected.length === 0 ? placeholder : "Add more..."}
          className="flex-1 min-w-[120px] bg-transparent text-xs font-medium text-slate-800 focus:outline-none placeholder:text-slate-400"
        />
      </div>

      {/* Floating option menu */}
      {isOpen && (
        <div className="absolute left-0 top-full mt-1 z-50 w-full max-h-56 bg-white border border-slate-200 rounded-xl shadow-xl overflow-y-auto p-1 divide-y divide-slate-100">
          {filteredOptions.length === 0 ? (
            <div className="p-3 text-center text-xs text-slate-400 italic">
              No matching standard option.
              {inputVal.trim() && (
                <button
                  type="button"
                  onClick={() => addItem(inputVal)}
                  className="block mt-1 mx-auto text-blue-600 font-bold hover:underline"
                >
                  + Add &quot;{inputVal.trim()}&quot; as custom tag
                </button>
              )}
            </div>
          ) : (
            filteredOptions.map((opt) => {
              const isSelected = selected.includes(opt.code);
              return (
                <button
                  key={opt.code}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleItem(opt.code);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2 text-left text-xs transition rounded-lg cursor-pointer ${
                    isSelected ? "bg-blue-50 text-blue-900 font-bold" : "hover:bg-slate-50 text-slate-700"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      readOnly
                      className="w-3.5 h-3.5 text-blue-600 rounded border-slate-300"
                    />
                    <span>{opt.label}</span>
                  </div>
                  <code className="text-[10px] font-mono text-slate-400 ml-2">{opt.code}</code>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
