"use client";

import { displayDate } from '../../../lib/dateDisplay';
// Public document submission — no login. Reached through the link staff share from a proposal (the proposal's
// "Documents" section). The customer sees the documents their plan requires and uploads each one.
// Like the e-application page, this deliberately does NOT use app/services/api.ts: that shared instance redirects to
// /login on 401 and attaches whatever staff token is in this browser, neither of which suits an anonymous customer.

import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { tx } from "@/lib/i18n/tx";

const publicApi = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  timeout: 120_000,
});

type DocState = "received" | "missing" | "reupload";
interface DocItem {
  document_type: string;
  state: DocState;
  files: { file_name: string; uploaded_at: string; status: string }[];
}
interface View {
  customer_name: string | null;
  plan_label: string | null;
  insurer_name: string | null;
  requirements: DocItem[];
  received: number;
  total: number;
  all_received: boolean;
  submitted: boolean;
  expires_at: string;
}
type Load = "loading" | "ready" | "expired" | "not_found" | "error";

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.heic,.tiff,.bmp";

const STATE_PILL: Record<DocState, { label: string; cls: string }> = {
  received: { label: "Received", cls: "border-blue-600 bg-blue-600 text-white" },
  missing: { label: "Needed", cls: "border-slate-300 bg-white text-slate-600" },
  reupload: { label: "Please upload again", cls: "border-slate-700 bg-slate-700 text-white" },
};

function Message({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-lg font-bold text-slate-900">{title}</h1>
        {body && <p className="mt-2 text-sm text-slate-600">{body}</p>}
      </div>
    </div>
  );
}

export default function DocumentsPage({ params }: { params: { token: string } }) {
  const { token } = params;
  const [load, setLoad] = useState<Load>("loading");
  const [view, setView] = useState<View | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    (async () => {
      try {
        const res = await publicApi.get<View>(`/public/documents/${token}`);
        setView(res.data);
        setLoad("ready");
      } catch (e: any) {
        const status = e?.response?.status;
        setLoad(status === 410 ? "expired" : status === 404 ? "not_found" : "error");
        setLoadError(typeof e?.response?.data?.detail === "string" ? e.response.data.detail : null);
      }
    })();
  }, [token]);

  const upload = async (documentType: string, file: File | undefined) => {
    if (!file) return;
    setUploading(documentType);
    setErrors((prev) => ({ ...prev, [documentType]: "" }));
    try {
      const form = new FormData();
      form.append("document_type", documentType);
      form.append("file", file);
      const res = await publicApi.post<View>(`/public/documents/${token}/upload`, form);
      setView(res.data);
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setErrors((prev) => ({
        ...prev,
        [documentType]: typeof detail === "string" ? detail : tx("That did not upload. Please try again."),
      }));
    } finally {
      setUploading(null);
      const input = inputs.current[documentType];
      if (input) input.value = ""; // so choosing the same file again still fires
    }
  };

  if (load === "loading") return <Message title={tx("Loading your documents…")} />;
  if (load === "expired")
    return <Message title={tx("This link has expired")} body={loadError ?? tx("Please ask your agent to send you a new link.")} />;
  if (load === "not_found")
    return <Message title={tx("This link is not valid")} body={tx("Please check the link, or ask your agent to send it again.")} />;
  if (load === "error" || !view) return <Message title={tx("Something went wrong")} body={tx("Please try again in a moment.")} />;

  if (view.submitted)
    return (
      <Message
        title={tx("Thank you")}
        body={tx("Your documents have been submitted. Your agent will take it from here. If something needs to change, please ask your agent.")}
      />
    );

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await publicApi.post<View>(`/public/documents/${token}/submit`);
      setView(res.data);
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setSubmitError(typeof detail === "string" ? detail : tx("That did not go through. Please try again."));
    } finally {
      setSubmitting(false);
    }
  };

  const firstName = (view.customer_name ?? "").split(" ")[0];
  const pct = view.total ? Math.round((view.received / view.total) * 100) : 100;

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto w-full max-w-2xl space-y-5">
        <header>
          {view.insurer_name && (
            <p className="text-[11px] font-bold uppercase tracking-wider text-blue-600">{view.insurer_name}</p>
          )}
          <h1 className="mt-1 text-2xl font-bold text-slate-900">
            {firstName ? tx("Hi {0}, please upload your documents", { 0: firstName }) : tx("Please upload your documents")}
          </h1>
          <p className="mt-1.5 text-sm text-slate-600">
            {view.plan_label
              ? tx("These are the documents needed for your {0} application. A clear photo or a PDF of each is fine.", { 0: view.plan_label })
              : tx("A clear photo or a PDF of each document is fine.")}
          </p>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-semibold text-slate-800">{tx("{0} of {1} received", { 0: view.received, 1: view.total })}</span>
            <span className="text-slate-500">{pct}%</span>
          </div>
          <div className="mt-2 h-2 rounded-full bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-2 rounded-full bg-blue-600 transition-all" style={{ width: `${pct}%` }} />
          </div>
          {view.all_received && (
            <p className="mt-3 rounded-lg border border-blue-100 bg-blue-50 px-3.5 py-2.5 text-sm text-blue-900">
              {tx("All your documents are in. Thank you — your agent will take it from here.")}
            </p>
          )}
        </section>

        {view.total === 0 ? (
          <p className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-600 shadow-sm">
            {tx("No documents are needed for this plan.")}
          </p>
        ) : (
          <ul className="space-y-3">
            {view.requirements.map((doc) => {
              const pill = STATE_PILL[doc.state];
              const busy = uploading === doc.document_type;
              return (
                <li key={doc.document_type} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <h2 className="text-sm font-bold text-slate-900">{doc.document_type}</h2>
                      <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${pill.cls}`}>{tx(pill.label)}</span>
                    </div>
                    <div>
                      <input
                        ref={(el) => { inputs.current[doc.document_type] = el; }}
                        type="file"
                        accept={ACCEPT}
                        className="hidden"
                        onChange={(e) => upload(doc.document_type, e.target.files?.[0])}
                      />
                      <button
                        type="button"
                        disabled={uploading !== null}
                        onClick={() => inputs.current[doc.document_type]?.click()}
                        className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                          doc.state === "received"
                            ? "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                            : "bg-blue-600 text-white hover:bg-blue-700"
                        }`}
                      >
                        {busy ? tx("Uploading…") : doc.state === "received" ? tx("Add another") : tx("Upload")}
                      </button>
                    </div>
                  </div>

                  {doc.state === "reupload" && (
                    <p className="mt-2 text-xs text-slate-600">{tx("We could not read the last file. A sharper, well-lit photo or a PDF works best.")}</p>
                  )}
                  {doc.files.length > 0 && (
                    <ul className="mt-3 space-y-1 border-t border-slate-100 pt-3">
                      {doc.files.map((f, i) => (
                        <li key={`${f.file_name}-${i}`} className="flex items-center justify-between gap-3 text-xs text-slate-600">
                          <span className="truncate">{f.file_name}</span>
                          <span className="shrink-0 text-slate-400">{displayDate(f.uploaded_at)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {errors[doc.document_type] && (
                    <p role="alert" className="mt-2 text-xs font-medium text-slate-800">{errors[doc.document_type]}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {view.all_received && (
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="w-full rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? tx("Submitting…") : tx("Done")}
          </button>
        )}
        {submitError && <p role="alert" className="text-center text-xs font-medium text-slate-800">{submitError}</p>}
        {view.all_received && (
          <p className="text-center text-xs text-slate-500">{tx("Once you press Done, the documents are submitted and cannot be changed.")}</p>
        )}

        <p className="text-center text-xs text-slate-400">
          {tx("This link is private to you. Please do not share it.")}
        </p>
      </div>
    </div>
  );
}
