"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import type { AgentMessage, ProcessStep, QuickAction } from "@/lib/agent/types";
import { QuickActionSelect } from "./QuickActionSelect";
import { isPassiveAction } from "@/lib/agent/quickActions";

/**
 * Floating status card on the journey map. A step started from the map runs in
 * the chat underneath without leaving the map; this card is the window onto
 * it — what the copilot is doing right now, its reply as it streams, and any
 * question or buttons it needs answered (confirmations, choices, uploads), so
 * the whole step can be finished from the map.
 */
export function JourneyActivityPanel({
  title,
  working,
  awaitingInput,
  steps,
  message,
  actions,
  usedIdx,
  onAction,
  onSelectRun,
  onSelected,
  onOpenChat,
  onDismiss,
}: {
  title?: string;
  working: boolean;
  awaitingInput: boolean;
  steps: ProcessStep[];
  message: AgentMessage | null;
  actions: QuickAction[];
  usedIdx?: number;
  onAction: (idx: number, action: QuickAction) => void;
  onSelectRun: (text: string) => void;
  onSelected: (idx: number, label: string) => void;
  onOpenChat: () => void;
  onDismiss: () => void;
}) {
  const activeStep = [...steps].reverse().find((s) => s.status === "active");
  const status = working
    ? { tone: "indigo", label: activeStep?.label || "Copilot is working…" }
    : awaitingInput
      ? { tone: "amber", label: "Copilot needs your input" }
      : { tone: "emerald", label: "Done" };

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md shadow-[0_12px_40px_-12px_rgba(0,0,0,0.25)] overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300">
      {/* Status bar */}
      <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-zinc-100 dark:border-zinc-800">
        {working ? (
          <span className="relative w-4 h-4 flex items-center justify-center shrink-0">
            <span className="absolute inset-0 rounded-full border-2 border-indigo-200 dark:border-indigo-500/30" />
            <span className="absolute inset-0 rounded-full border-2 border-transparent border-t-indigo-500 animate-spin" />
          </span>
        ) : (
          <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${status.tone === "amber" ? "bg-amber-500 animate-pulse" : "bg-emerald-500"}`} />
        )}
        <div className="min-w-0 flex-1">
          {title && <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 truncate">{title}</div>}
          <div className="text-[12.5px] font-semibold text-zinc-800 dark:text-zinc-100 truncate">{status.label}</div>
        </div>
        <button
          type="button"
          onClick={onOpenChat}
          className="text-[11.5px] font-semibold text-zinc-500 hover:text-indigo-600 dark:text-zinc-400 dark:hover:text-indigo-300 px-2 py-1 rounded-lg hover:bg-zinc-100 dark:hover:bg-white/5"
        >
          Open in chat
        </button>
        {!working && !awaitingInput && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:text-zinc-200 dark:hover:bg-white/5"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3.5 h-3.5"><path d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        )}
      </div>

      {/* What the agent has done so far this turn */}
      {steps.length > 0 && (
        <div className="px-4 pt-2.5 flex flex-wrap gap-x-3 gap-y-1">
          {steps.slice(-5).map((s) => (
            <span key={s.id} className="inline-flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              <span className={`w-1.5 h-1.5 rounded-full ${s.status === "done" ? "bg-emerald-500" : s.status === "error" ? "bg-rose-500" : "bg-indigo-500 animate-pulse"}`} />
              {s.label}
            </span>
          ))}
        </div>
      )}

      {/* Its reply — streams in live */}
      {message?.text && (
        <div className="px-4 pt-2.5 max-h-56 overflow-y-auto custom-scrollbar text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-200 [&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:pl-4 [&_ul]:list-disc [&_li]:my-0.5 [&_strong]:font-semibold [&_strong]:text-zinc-900 dark:[&_strong]:text-white [&_h3]:font-bold [&_h3]:mt-2 [&_code]:text-[11.5px] [&_a]:text-indigo-600 dark:[&_a]:text-indigo-300 [&_a]:underline">
          <ReactMarkdown>{message.text}</ReactMarkdown>
        </div>
      )}

      {/* Whatever it's asking for */}
      {!working && actions.length > 0 && (
        <div className="px-4 py-3 flex flex-wrap gap-2">
          {actions.map((action, idx) => {
            if (action.actionType === "select") {
              return (
                <QuickActionSelect
                  key={`sel-${idx}`}
                  action={action}
                  onRun={onSelectRun}
                  variant="card"
                  selectedLabel={message?.selections?.[idx]}
                  onSelected={(label) => onSelected(idx, label)}
                />
              );
            }
            const chosen = usedIdx === idx;
            const locked = !isPassiveAction(action) && usedIdx !== undefined && !chosen;
            return (
              <button
                key={`${action.actionType}-${idx}`}
                type="button"
                disabled={locked}
                onClick={() => onAction(idx, action)}
                className={`px-3 py-1.5 text-[12px] font-semibold rounded-xl border transition-colors ${
                  chosen
                    ? "bg-indigo-600 border-indigo-600 text-white"
                    : locked
                      ? "border-zinc-200 text-zinc-400 dark:border-zinc-800 dark:text-zinc-600 cursor-not-allowed"
                      : idx === 0
                        ? "border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300"
                        : "border-zinc-200 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                }`}
              >
                {action.label}
              </button>
            );
          })}
        </div>
      )}
      {(working || actions.length === 0) && <div className="h-3" />}
    </div>
  );
}
