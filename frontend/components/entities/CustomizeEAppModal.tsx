"use client";

import { useState } from "react";
import { saveCustomQuestions, CustomQuestion } from "@/app/services/eApplication";

interface CustomizeEAppModalProps {
  caseId: string;
  customerName?: string;
  initialQuestions?: CustomQuestion[];
  onClose: () => void;
  onSaved: () => void;
}

export default function CustomizeEAppModal({
  caseId,
  customerName,
  initialQuestions = [],
  onClose,
  onSaved,
}: CustomizeEAppModalProps) {
  const [questions, setQuestions] = useState<CustomQuestion[]>(initialQuestions);
  const [newQuestion, setNewQuestion] = useState("");
  const [newType, setNewType] = useState<"yes_no" | "text" | "number">("yes_no");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleAddQuestion = () => {
    if (!newQuestion.trim()) return;
    const q: CustomQuestion = {
      id: `cq_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      question: newQuestion.trim(),
      type: newType,
      section: "Custom Disclosure",
    };
    setQuestions([...questions, q]);
    setNewQuestion("");
  };

  const handleRemoveQuestion = (id: string) => {
    setQuestions(questions.filter((q) => q.id !== id));
  };

  const handleSave = async () => {
    setSaving(true);
    setErr(null);
    try {
      await saveCustomQuestions(caseId, questions);
      onSaved();
    } catch (e: any) {
      setErr(e?.message || "Failed to save custom questions");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden border border-slate-100"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-blue-900 to-indigo-900 text-white flex items-center justify-between">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-blue-300">
              E-Application Questionnaire Customization
            </span>
            <h3 className="text-base font-bold text-white">
              Add Custom Questions {customerName ? `for ${customerName}` : ""}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-white/70 hover:text-white text-lg font-bold p-1 rounded-lg hover:bg-white/10"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
          <p className="text-xs text-slate-500 leading-relaxed">
            Customize the questionnaire before generating or sending the E-Application link to the customer. Any custom questions added here will be included in the form for the applicant to complete.
          </p>

          {/* Standard sections overview */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 space-y-1.5">
            <p className="text-xs font-bold text-slate-700 uppercase tracking-wide">
              Standard Form Sections (Included)
            </p>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {[
                "1. Applicant Details",
                "2. Basic Health (Height/Weight/BMI/Tobacco)",
                "3. Medical Conditions Checklist",
                "4. Hospitalizations & Surgeries",
                "5. Regulatory Disclosures",
                "6. Family Medical History",
                "7. Lifestyle & Foreign Travel",
                "8. Existing Insurance Policies",
                "9. Legal Declaration & E-Signature",
              ].map((sec) => (
                <span
                  key={sec}
                  className="px-2 py-1 rounded text-[11px] font-medium bg-white text-slate-600 border border-slate-200"
                >
                  ✓ {sec}
                </span>
              ))}
            </div>
          </div>

          {/* Add custom question builder */}
          <div className="border border-blue-100 bg-blue-50/50 rounded-xl p-4 space-y-3">
            <p className="text-xs font-bold text-blue-900 uppercase tracking-wide">
              + Add Additional Custom Question
            </p>

            <div className="space-y-2">
              <input
                type="text"
                value={newQuestion}
                onChange={(e) => setNewQuestion(e.target.value)}
                placeholder="Enter custom question (e.g., Do you engage in high-altitude mountaineering?)"
                className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white text-slate-800 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-slate-600">Answer Type:</span>
                  <select
                    value={newType}
                    onChange={(e) => setNewType(e.target.value as any)}
                    className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white text-slate-700 focus:outline-none"
                  >
                    <option value="yes_no">Yes / No with details</option>
                    <option value="text">Free text response</option>
                    <option value="number">Numeric value</option>
                  </select>
                </div>
                <button
                  onClick={handleAddQuestion}
                  disabled={!newQuestion.trim()}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
                >
                  Add Question
                </button>
              </div>
            </div>
          </div>

          {/* List of custom questions */}
          <div className="space-y-2">
            <p className="text-xs font-bold text-slate-700 uppercase tracking-wide">
              Configured Custom Questions ({questions.length})
            </p>
            {questions.length === 0 ? (
              <p className="text-xs text-slate-400 italic bg-slate-50 border border-slate-200 rounded-lg p-3 text-center">
                No custom questions added yet. The standard questionnaire will be sent.
              </p>
            ) : (
              <div className="space-y-2">
                {questions.map((q, idx) => (
                  <div
                    key={q.id || idx}
                    className="flex items-start justify-between gap-3 bg-white border border-slate-200 rounded-xl p-3 shadow-xs hover:border-blue-300 transition-colors"
                  >
                    <div className="space-y-1">
                      <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-100 uppercase">
                        Q{idx + 1} · {q.type === "yes_no" ? "Yes/No" : q.type}
                      </span>
                      <p className="text-xs font-semibold text-slate-800 leading-snug">
                        {q.question}
                      </p>
                    </div>
                    <button
                      onClick={() => handleRemoveQuestion(q.id)}
                      className="text-slate-400 hover:text-red-600 p-1 text-xs font-bold transition-colors"
                      title="Remove question"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {err && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {err}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 rounded-xl text-xs font-bold bg-blue-600 hover:bg-blue-700 text-white shadow-sm disabled:opacity-40 transition-all flex items-center gap-2"
          >
            {saving ? "Saving Customization..." : "Save Questionnaire & Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}
