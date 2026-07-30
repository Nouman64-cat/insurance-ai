"use client";

export type EntryEntityType = "INDIVIDUAL" | "FAMILY" | "CORPORATE";

const ENTITY_META: Record<EntryEntityType, { title: string; accent: string; quickHint: string; fullHint: string }> = {
  INDIVIDUAL: {
    title: "Add Individual",
    accent: "emerald",
    quickHint: "Just name & phone — capture the lead in seconds.",
    fullHint: "Full underwriting profile: identity, medical, financial, nominee & plan.",
  },
  FAMILY: {
    title: "Add Family",
    accent: "indigo",
    quickHint: "Household name & contact — add members and policy later.",
    fullHint: "Complete household entry with contact, email & annual income.",
  },
  CORPORATE: {
    title: "Add Corporate",
    accent: "blue",
    quickHint: "Company name & contact — set up the master policy later.",
    fullHint: "Complete corporate entry with registration, industry & contacts.",
  },
};

interface Props {
  entityType: EntryEntityType | null;
  onClose: () => void;
  onSelect: (mode: "quick" | "full") => void;
}

export default function AddEntryChooser({ entityType, onClose, onSelect }: Props) {
  if (!entityType) return null;
  const meta = ENTITY_META[entityType];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-lg w-full p-6 space-y-5">
        <div className="flex justify-between items-start">
          <div>
            <h3 className="text-lg font-bold text-slate-900">{meta.title}</h3>
            <p className="text-xs text-slate-500 mt-0.5">How much do you want to capture right now?</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 bg-slate-50 hover:bg-slate-100 rounded-full p-1 transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <button
            type="button"
            onClick={() => onSelect("quick")}
            className="group text-left rounded-xl border-2 border-slate-200 hover:border-blue-400 hover:bg-blue-50/40 p-5 transition-all"
          >
            <div className="w-10 h-10 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center mb-3">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div className="text-sm font-bold text-slate-800 group-hover:text-blue-700">Quick Lead</div>
            <p className="text-xs text-slate-500 mt-1 leading-relaxed">{meta.quickHint}</p>
          </button>

          <button
            type="button"
            onClick={() => onSelect("full")}
            className="group text-left rounded-xl border-2 border-slate-200 hover:border-blue-400 hover:bg-blue-50/40 p-5 transition-all"
          >
            <div className="w-10 h-10 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center mb-3">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div className="text-sm font-bold text-slate-800 group-hover:text-blue-700">Complete Detail</div>
            <p className="text-xs text-slate-500 mt-1 leading-relaxed">{meta.fullHint}</p>
          </button>
        </div>
      </div>
    </div>
  );
}
