"use client";

import { useEffect, useRef, useState } from "react";

type Finding = {
  code: string;
  severity: string;
  category: string;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
};
type Report = {
  path: string;
  file_type: string;
  sha256: string;
  size: number;
  verdict: "no_evidence" | "review" | "high_risk" | "inconclusive";
  layer2_status: string | null;
  layer3_status: string | null;
  incomplete: string[];
  findings: Finding[];
  errors: string[];
  performance?: {
    total_seconds: number;
    layer_seconds: Record<string, number>;
    input_bytes: number;
    model_calls: number;
    model_input_tokens: number | null;
    model_output_tokens: number | null;
    pixel_pages_scored: number;
    pixel_inference_seconds: number;
    complete: boolean;
  };
  pixel_forensics?: {
    model: string;
    calibrated: boolean;
    calibration?: {
      t95: number;
      tmax: number;
      n_calibration: number;
      n_validation: number;
      fpr_at_tmax: number | null;
      scope: string;
      provisional: boolean;
    } | null;
    seconds: number;
    pages: {
      page: number;
      score: number;
      map_p99?: number;
      map_png_b64?: string;
      seconds: number;
    }[];
  } | null;
};
const MAX_SIZE = 100 * 1024 * 1024;
const ACCEPT =
  ".pdf,.jpg,.jpeg,.jpe,.jfif,.png,.webp,.tif,.tiff,.gif,.heic,.heif,.bmp";
const VERDICTS = {
  no_evidence: {
    title: "No evidence detected",
    description:
      "The selected checks found no actionable evidence of manipulation. This does not verify authenticity.",
    icon: "✓",
  },
  review: {
    title: "Human review recommended",
    description:
      "The analysis found signals that need a closer look. Review the evidence below alongside the original document.",
    icon: "!",
  },
  high_risk: {
    title: "High-risk evidence detected",
    description:
      "Strong signals of manipulation were found. Review the specific findings before making a decision.",
    icon: "!",
  },
  inconclusive: {
    title: "Analysis is inconclusive",
    description:
      "The document could not be fully assessed. Review the analysis notes and try again with a readable file or different options.",
    icon: "?",
  },
};
const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;

function Icon({ name }: { name: "shield" | "upload" | "file" | "arrow" }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "shield" && (
        <>
          <path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" />
          <path d="m8 12 3 3 5-6" />
        </>
      )}
      {name === "upload" && (
        <>
          <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />
        </>
      )}
      {name === "file" && (
        <>
          <path d="M14 3H5v18h14V8l-5-5Z" />
          <path d="M14 3v6h5M8 13h8m-8 4h5" />
        </>
      )}
      {name === "arrow" && (
        <>
          <path d="M4 12h16m-6-6 6 6-6 6" />
        </>
      )}
    </svg>
  );
}

export default function DocumentIntelligenceWorkspace() {
  const [history, setHistory] = useState<{id:string; filename:string; status:string; verdict:string | null; created_at:string}[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  async function authenticatedFetch(path:string, options:RequestInit={}) {
    const response = await fetch(`/api/document-intelligence/${path}`, {...options, headers:{...options.headers, Authorization:`Bearer ${localStorage.getItem("jwt_token") || ""}`},cache:"no-store"});
    return response;
  }
  async function loadHistory(offset=historyOffset) {
    try {
      const response=await authenticatedFetch(`results?offset=${offset}&limit=10`);
      const value=await response.json();
      if (!response.ok) throw new Error(value.detail || "Could not load saved results");
      setHistory(value.items);setHistoryTotal(value.total);setHistoryError("");
    } catch(e) {setHistoryError(e instanceof Error ? e.message : "Could not load saved results");}
  }
  async function openSaved(id:string) {
    try {
      const response=await authenticatedFetch(`results/${id}`);const value=await response.json();
      if (!response.ok) throw new Error(value.detail || "Could not load saved result");
      if (!value.report) throw new Error(value.error || "This analysis is still processing. Refresh history shortly.");
      setFile(null);setConsent(false);setReport(value.report);setSelectedId(id);setError("");
    } catch(e) {setHistoryError(e instanceof Error ? e.message : "Could not load saved result");}
  }
  useEffect(() => {void loadHistory(historyOffset);},[historyOffset]);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [docType, setDocType] = useState("");
  const [layer2, setLayer2] = useState(false);
  const [layer3, setLayer3] = useState(false);
  const [visual, setVisual] = useState(false);
  const [consent, setConsent] = useState(false);
  const [provider, setProvider] = useState("gemini");
  const [pages, setPages] = useState(4);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [health, setHealth] = useState("checking");
  const [policy, setPolicy] = useState<{enabled:boolean; content_enabled:boolean; pixel_enabled:boolean; visual_enabled:boolean; provider:string; max_pages:number} | null>(null);
  const [pixelReady, setPixelReady] = useState<boolean | null>(null);
  const controller = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const check = new AbortController();
    authenticatedFetch("health", { signal: check.signal })
      .then(async (r) => {
        setHealth(r.ok ? "online" : "offline");
        const capabilities = await r.json();
        setPixelReady(capabilities.pixel_forensics?.available ?? null);
        if (capabilities.analysis_policy) {
          setPolicy(capabilities.analysis_policy);
          setProvider(capabilities.analysis_policy.provider);
          setConsent(false);
          setPages(p => Math.min(p, capabilities.analysis_policy.max_pages));
        }
        if (capabilities.platform_configuration === "unavailable") setHealth("offline");
      })
      .catch((e) => {
        if (e.name !== "AbortError") setHealth("offline");
      });
    return () => check.abort();
  }, []);
  useEffect(() => {
    if (
      !file ||
      !file.type.startsWith("image/") ||
      /\.(heic|heif|tiff?)$/i.test(file.name)
    ) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => () => controller.current?.abort(), []);

  function chooseFile(selected?: File) {
    if (running || !selected) return;
    if (fileInput.current) fileInput.current.value = "";
    setReport(null);
    setConsent(false);
    setError("");
    if (selected.size === 0) {
      setFile(null);
      setError("This file is empty. Choose a document with content.");
      return;
    }
    if (selected.size > MAX_SIZE) {
      setFile(null);
      setError("The document exceeds the 100 MiB limit.");
      return;
    }
    if (
      !ACCEPT.split(",").includes(
        `.${selected.name.split(".").pop()?.toLowerCase()}`,
      )
    ) {
      setFile(null);
      setError("Choose a PDF or a supported image file.");
      return;
    }
    setFile(selected);
  }

  async function analyze(event: React.FormEvent) {
    event.preventDefault();
    if (!file || running || (layer2 && !consent)) return;
    setRunning(true);
    setElapsed(0);
    setReport(null);
    setSelectedId("");
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    const data = new FormData();
    data.append("file", file);
    if (docType) data.append("doc_type", docType);
    data.append("layer2", String(layer2));
    data.append("layer3", String(layer3));
    data.append("provider", provider);
    data.append("visual", String(visual));
    data.append("max_pages", String(pages));
    try {
      const response = await authenticatedFetch("analyze", {
        method: "POST",
        body: data,
        signal: abort.signal,
      });
      const result = await response.json().catch(() => null);
      const payload = response.ok ? result?.report : result;
      if (!response.ok)
        throw new Error(
          typeof payload?.detail === "string"
            ? payload.detail
            : `Analysis failed (${response.status}). Check your options and try again.`,
        );
      if (
        !payload ||
        !(payload.verdict in VERDICTS) ||
        !Array.isArray(payload.findings)
      )
        throw new Error(
          "The service returned an unexpected report. Please try again.",
        );
      setReport(payload);
      setSelectedId(result.id);
      void loadHistory();
      setHealth("online");
    } catch (e) {
      setError(
        e instanceof Error && e.name === "AbortError"
          ? "Upload view cancelled. Analysis may still finish and be saved; check history before retrying."
          : e instanceof Error
            ? e.message
            : "Analysis failed. Please try again.",
      );
    } finally {
      void loadHistory();
      setRunning(false);
      controller.current = null;
    }
  }

  function download() {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${report.path.replace(/[^a-zA-Z0-9._-]/g, "_")}.forensics.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const visibleFindings =
    report?.findings.filter((f) => showInfo || f.severity !== "info") || [];
  return (
    <div className="document-intelligence">
      <header className="topbar">
        <a href="/admin/document-intelligence" className="brand">
          <span className="brand-icon">
            <Icon name="shield" />
          </span>
          <span>
            Insurance<span className="brand-light">AI</span>
          </span>
          <span className="brand-divider" />
          <span className="product-name">Document intelligence</span>
        </a>
        <span className="public-badge">
          <span />
          Tenant Admin workspace
        </span>
      </header>
      <main>
        <div className="intro">
          <div>
            <div className="eyebrow">DOCUMENT FORENSICS</div>
            <h1>
              A closer look at
              <br className="mobile-break" /> document integrity.
            </h1>
            <p>Inspect the file. Check the figures. Understand the evidence.</p>
          </div>
          <div className={`service-status ${health}`}>
            <span />
            {health === "online"
              ? "Analysis service online"
              : health === "offline"
                ? "Analysis service unavailable"
                : "Connecting to analysis service"}
          </div>
        </div>
        <section id="saved-results" className="setup-panel" style={{padding:24,marginBottom:24}}>
          <div style={{display:"flex",justifyContent:"space-between",gap:16,flexWrap:"wrap"}}><div><h2>Saved analyses</h2><p>Reports are stored for your organisation. Original uploaded files are not retained.</p></div><button type="button" onClick={() => void loadHistory()}>Refresh history</button></div>
          {selectedId && <p role="status">Viewing saved analysis: {selectedId}</p>}
          {historyError && <p role="alert">{historyError}</p>}
          <div style={{overflowX:"auto"}}><table style={{width:"100%",textAlign:"left",marginTop:16}}><thead><tr><th>Document</th><th>Created</th><th>Status</th><th>Verdict</th><th>Report</th></tr></thead><tbody>{history.map(item=><tr key={item.id}><td style={{padding:"12px 0",wordBreak:"break-word"}}>{item.filename}</td><td>{new Date(item.created_at.endsWith("Z") ? item.created_at : item.created_at+"Z").toLocaleString()}</td><td>{item.status}</td><td>{item.verdict || "—"}</td><td><button type="button" onClick={() => void openSaved(item.id)}>Open report</button></td></tr>)}</tbody></table></div>
          {!history.length && !historyError && <p>No saved analyses yet. Upload a document below.</p>}
          <div style={{display:"flex",gap:16,marginTop:16}}><button disabled={historyOffset === 0} onClick={() => setHistoryOffset(n=>Math.max(0,n-10))}>Previous</button><span>{historyOffset+1 > historyTotal ? 0 : historyOffset+1}–{Math.min(historyOffset+10,historyTotal)} of {historyTotal}</span><button disabled={historyOffset+10 >= historyTotal} onClick={() => setHistoryOffset(n=>n+10)}>Next</button></div>
        </section>
        <div className="workspace">
          <form onSubmit={analyze} className="setup-panel">
            <div className="panel-heading">
              <span className="step">01</span>
              <div>
                <h2>Prepare your analysis</h2>
                <p>One document, multiple layers of evidence.</p>
              </div>
            </div>
            {policy?.enabled === false && <p role="status" className="error-banner">Document Forgery Detection is disabled by SuperAdmin.</p>}
            <fieldset disabled={running || policy?.enabled === false}>
              <label
                className={`dropzone ${dragging ? "dragging" : ""} ${file ? "selected" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  chooseFile(e.dataTransfer.files[0]);
                }}
              >
                <input
                  ref={fileInput}
                  className="file-input"
                  type="file"
                  accept={ACCEPT}
                  aria-label="Upload document"
                  onChange={(e) => chooseFile(e.target.files?.[0])}
                />
                <span className="upload-icon">
                  <Icon name={file ? "file" : "upload"} />
                </span>
                <strong>{file ? file.name : "Drop a document here"}</strong>
                <span>
                  {file ? (
                    `${size(file.size)} · Click to replace`
                  ) : (
                    <>
                      or <b>browse files</b> on your device
                    </>
                  )}
                </span>
                <small>PDF, JPG, PNG, WebP, TIFF & more · Up to 100 MiB</small>
              </label>
              <label className="field-label" htmlFor="doc-type">
                Document type
              </label>
              <select
                id="doc-type"
                value={docType}
                onChange={(e) => setDocType(e.target.value)}
              >
                <option value="">Auto-detect</option>
                <option value="bank_statement">Bank statement</option>
                <option value="payslip">Payslip</option>
                <option value="invoice">Invoice</option>
                <option value="receipt">Receipt</option>
                <option value="other">Other document</option>
              </select>
              <div className="section-label">ANALYSIS LAYERS</div>
              <div className="layer-row">
                <span className="layer-number">1</span>
                <div>
                  <strong>File & metadata</strong>
                  <p>Edit history, fonts, signatures and overlays.</p>
                </div>
                <span className="always-on">Always on</span>
              </div>
              <label className="layer-row clickable">
                <span className="layer-number">2</span>
                <div>
                  <strong>Content consistency</strong>
                  <p>Check totals, balances, dates and identifiers.</p>
                </div>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="Content consistency"
                  checked={layer2}
                  disabled={policy?.content_enabled === false}
                  onChange={(e) => setLayer2(e.target.checked)}
                />
              </label>
              {layer2 && (
                <div className="layer-options">
                  <label className="field-label" htmlFor="provider">
                    Model provider
                  </label>
                  <select
                    disabled={policy !== null}
                    id="provider"
                    value={provider}
                    onChange={(e) => {
                      setProvider(e.target.value);
                      setConsent(false);
                    }}
                  >
                    <option value="gemini">Google Gemini</option>
                    <option value="groq">Groq</option>
                  </select>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={visual}
                      disabled={policy?.visual_enabled === false}
                      onChange={(e) => setVisual(e.target.checked)}
                    />
                    Include visual model inspection
                  </label>
                  <label className="consent checkbox-row">
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    <span>
                      I agree to send this document’s pages to{" "}
                      {provider === "gemini" ? "Google Gemini" : "Groq"} for
                      analysis.
                    </span>
                  </label>
                </div>
              )}
              <label className="layer-row clickable">
                <span className="layer-number">3</span>
                <div>
                  <strong>
                    Pixel forensics{" "}
                    <span className="experimental">Experimental</span>
                  </strong>
                  <p>
                    {pixelReady === true
                      ? "TruFor CPU runtime ready. Runs locally."
                      : pixelReady === false
                        ? "TruFor unavailable. Rebuild the backend image."
                        : "Bundled TruFor model. Runs locally on CPU."}
                  </p>
                </div>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="Pixel forensics"
                  checked={layer3}
                  disabled={policy?.pixel_enabled === false}
                  onChange={(e) => setLayer3(e.target.checked)}
                />
              </label>
              {(layer2 || layer3) && (
                <div className="pages-field">
                  <label htmlFor="pages">
                    Pages to analyze <small>Layers 2 & 3 · maximum 40</small>
                  </label>
                  <input
                    id="pages"
                    type="number"
                    min="1"
                    max="40"
                    required
                    value={pages}
                    onChange={(e) => setPages(Number(e.target.value))}
                  />
                </div>
              )}
            </fieldset>
            {error && (
              <div className="error-message" role="alert">
                {error}
              </div>
            )}
            <button
              className="analyze-button"
              disabled={!file || running || (layer2 && !consent)}
              type="submit"
            >
              {running ? (
                <>
                  <span className="spinner" />
                  Analyzing document · {elapsed}s
                </>
              ) : (
                <>
                  Analyze document
                  <Icon name="arrow" />
                </>
              )}
            </button>
            {running ? (
              <button
                className="cancel-button"
                type="button"
                onClick={() => controller.current?.abort()}
              >
                Cancel analysis
              </button>
            ) : (
              <p className="local-note">
                <Icon name="shield" />
                File checks run locally. Model analysis is opt-in.
              </p>
            )}
          </form>
          <section
            className="results-panel"
            aria-label="Analysis results"
            aria-busy={running}
          >
            <div className="results-heading">
              <div>
                <span className="eyebrow">02 / EVIDENCE WORKSPACE</span>
                <h2>Analysis report</h2>
                <a className="metrics-link" href="#saved-results">
                  Saved results →
                </a>
              </div>
              {report && (
                <button className="secondary-button" onClick={download}>
                  Download JSON ↓
                </button>
              )}
            </div>
            {running ? (
              <div className="empty-state" role="status">
                <div className="scan-document scanning">
                  <Icon name="file" />
                  <span />
                  <span />
                  <span />
                </div>
                <h3>Looking beneath the surface</h3>
                <p>
                  Running the selected checks on your document.
                  <br />
                  {layer2 || layer3
                    ? "Model analysis can take several minutes."
                    : "File checks usually finish in a few moments."}
                </p>
                <div className="progress-track">
                  <span />
                </div>
              </div>
            ) : report ? (
              <div className="report" aria-live="polite">
                <div className={`verdict ${report.verdict}`}>
                  <span className="verdict-icon">
                    {VERDICTS[report.verdict].icon}
                  </span>
                  <div>
                    <span className="eyebrow">ANALYSIS OUTCOME</span>
                    <h3>{VERDICTS[report.verdict].title}</h3>
                    <p>{VERDICTS[report.verdict].description}</p>
                  </div>
                </div>
                <div className="report-file">
                  <span className="report-file-icon">
                    <Icon name="file" />
                  </span>
                  <div>
                    <strong>{report.path}</strong>
                    <span>
                      {report.file_type.toUpperCase()} · {size(report.size)}
                    </span>
                  </div>
                  <span className="complete-badge">Report ready</span>
                </div>
                <div className="layer-statuses">
                  <div>
                    <span>FILE CHECKS</span>
                    <strong>
                      {report.verdict === "inconclusive" &&
                      report.errors.some((e) => e.startsWith("pdf:"))
                        ? "Unreadable"
                        : "Run complete"}
                    </strong>
                  </div>
                  <div>
                    <span>CONTENT CHECKS</span>
                    <strong>{report.layer2_status || "Not requested"}</strong>
                  </div>
                  <div>
                    <span>PIXEL FORENSICS</span>
                    <strong>{report.layer3_status || "Not requested"}</strong>
                  </div>
                </div>
                {report.performance &&
                  Object.keys(report.performance).length > 0 && (
                    <section
                      className="report-performance"
                      aria-label="Analysis performance"
                    >
                      <div className="findings-heading">
                        <h3>Analysis performance</h3>
                        <span>
                          {report.performance.complete
                            ? "All requested checks completed"
                            : "Incomplete analysis"}
                        </span>
                      </div>
                      <div className="metrics-cards compact">
                        <article>
                          <span>TOTAL ANALYSIS</span>
                          <strong>
                            {report.performance.total_seconds.toFixed(3)}s
                          </strong>
                        </article>
                        <article>
                          <span>MODEL CALLS</span>
                          <strong>{report.performance.model_calls}</strong>
                        </article>
                        <article>
                          <span>PIXEL PAGES</span>
                          <strong>
                            {report.performance.pixel_pages_scored}
                          </strong>
                        </article>
                      </div>
                      <div className="timing-rows">
                        {Object.entries(report.performance.layer_seconds).map(
                          ([layer, seconds]) => (
                            <div key={layer}>
                              <span>
                                {layer === "layer1"
                                  ? "File & metadata"
                                  : layer === "layer2"
                                    ? "Content consistency"
                                    : "Pixel forensics"}
                              </span>
                              <strong>{seconds.toFixed(3)}s</strong>
                            </div>
                          ),
                        )}
                      </div>
                      <p className="metric-caption">
                        Server processing time excludes upload and browser
                        rendering. Pixel time includes rendering, queueing,
                        model loading and inference.
                      </p>
                      {report.performance.model_calls > 0 && (
                        <p className="metric-caption">
                          Reported input / output tokens:{" "}
                          {report.performance.model_input_tokens ??
                            "unavailable"}{" "}
                          /{" "}
                          {report.performance.model_output_tokens ??
                            "unavailable"}
                        </p>
                      )}
                    </section>
                  )}
                {report.pixel_forensics &&
                  report.pixel_forensics.pages.length > 0 && (
                    <section
                      className="pixel-results"
                      aria-label="Pixel forensics results"
                    >
                      <div className="findings-heading">
                        <h3>Pixel forensics</h3>
                        <span>
                          {report.pixel_forensics.model} ·{" "}
                          {report.pixel_forensics.seconds.toFixed(1)}s
                        </span>
                      </div>
                      {!report.pixel_forensics.calibrated && (
                        <p className="pixel-caveat">
                          Uncalibrated model output: scores and lighter heatmap
                          regions indicate model-detected anomalies. They are
                          not a probability that this document is forged and do
                          not determine the verdict.
                        </p>
                      )}
                      {report.pixel_forensics.calibration && (
                        <div
                          className="pixel-caveat"
                          aria-label="Configured pixel thresholds"
                        >
                          <strong>
                            {report.pixel_forensics.calibration.scope === "superadmin_manual" ? "SuperAdmin manual thresholds configured" : "Provisional reference thresholds configured"}
                          </strong>
                          <div className="threshold-values">
                            <span>
                              Informational cutoff (t95):{" "}
                              <b>
                                {report.pixel_forensics.calibration.t95.toFixed(
                                  6,
                                )}
                              </b>
                            </span>
                            <span>
                              Low-severity cutoff (tmax):{" "}
                              <b>
                                {report.pixel_forensics.calibration.tmax.toFixed(
                                  6,
                                )}
                              </b>
                            </span>
                          </div>
                          <p>
                            {report.pixel_forensics.calibration.scope === "superadmin_manual" ? "Manual cutoffs have no calibration or validation claim. " : <>Measured on{" "}
                            {report.pixel_forensics.calibration.n_calibration}{" "}
                            reference pages; checked on{" "}
                            {report.pixel_forensics.calibration.n_validation}{" "}
                            separate genuine-reference pages
                            {report.pixel_forensics.calibration.fpr_at_tmax !==
                            null
                              ? ` (${(report.pixel_forensics.calibration.fpr_at_tmax * 100).toFixed(1)}% above the low-severity cutoff)`
                              : ""}
                            . </>}This policy is not validated for your customer
                            documents. Pixel findings remain low-severity hints
                            and cannot determine the verdict alone.
                          </p>
                        </div>
                      )}
                      <div className="pixel-pages">
                        {report.pixel_forensics.pages.map((page) => (
                          <article className="pixel-page" key={page.page}>
                            <div>
                              <strong>Page {page.page}</strong>
                              <span>
                                Model score <b>{page.score.toFixed(4)}</b>
                              </span>
                            </div>
                            {page.map_png_b64 && (
                              <img
                                src={`data:image/png;base64,${page.map_png_b64}`}
                                alt={`TruFor anomaly heatmap for page ${page.page}; lighter regions indicate stronger anomalies`}
                              />
                            )}
                            <small>
                              Raw anomaly heatmap · {page.seconds.toFixed(1)}s
                              inference
                            </small>
                            {report.pixel_forensics?.calibration && (
                              <p className="metric-caption">
                                {page.score >=
                                report.pixel_forensics.calibration.tmax
                                  ? "At or above LOW cutoff · LOW signal"
                                  : page.score >=
                                      report.pixel_forensics.calibration.t95
                                    ? "At or above INFO cutoff · INFO signal"
                                    : "Below informational cutoff"}
                              </p>
                            )}
                          </article>
                        ))}
                      </div>
                    </section>
                  )}
                {(report.errors.length > 0 || report.incomplete.length > 0) && (
                  <div className="analysis-notes">
                    <strong>Analysis notes</strong>
                    {report.incomplete.length > 0 && (
                      <p>
                        Incomplete: {report.incomplete.join(", ")}. These checks
                        could not fully run.
                      </p>
                    )}
                    {report.errors.map((e, i) => (
                      <p key={i}>{e}</p>
                    ))}
                  </div>
                )}
                <div className="findings-heading">
                  <h3>
                    Findings <span>{visibleFindings.length}</span>
                  </h3>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={showInfo}
                      onChange={(e) => setShowInfo(e.target.checked)}
                    />
                    Include informational
                  </label>
                </div>
                {visibleFindings.length === 0 ? (
                  <div className="no-findings">
                    <span>{report.verdict === "inconclusive" ? "?" : "✓"}</span>
                    <strong>No actionable findings available</strong>
                    <p>
                      {report.verdict === "inconclusive"
                        ? "Some checks could not complete. Review the analysis notes above."
                        : "No signals meet the reporting threshold for the selected checks."}
                    </p>
                  </div>
                ) : (
                  <div className="findings">
                    {visibleFindings.map((finding, index) => (
                      <article
                        className="finding"
                        key={`${finding.code}-${index}`}
                      >
                        <div className="finding-top">
                          <span className={`severity ${finding.severity}`}>
                            {finding.severity}
                          </span>
                          <span className="finding-category">
                            {finding.category.replace(/_/g, " ")}
                          </span>
                        </div>
                        <h4>{finding.title}</h4>
                        <p>{finding.detail}</p>
                        <details>
                          <summary>
                            View evidence <span>{finding.code}</span>
                          </summary>
                          <pre>{JSON.stringify(finding.evidence, null, 2)}</pre>
                        </details>
                      </article>
                    ))}
                  </div>
                )}
                <details className="fingerprint">
                  <summary>
                    Document fingerprint <span>SHA-256</span>
                  </summary>
                  <code>{report.sha256}</code>
                </details>
              </div>
            ) : (
              <div className="empty-state">
                <div className="scan-document">
                  <Icon name="file" />
                  <span />
                  <span />
                  <span />
                  <div className="scan-check">✓</div>
                </div>
                <span className="eyebrow">READY WHEN YOU ARE</span>
                <h3>Every detail tells a story.</h3>
                <p>
                  Upload a financial document to inspect its integrity.
                  <br />
                  Your findings and supporting evidence will appear here.
                </p>
                <div className="supported-docs">
                  <span>Bank statements</span>
                  <span>Payslips</span>
                  <span>Invoices & receipts</span>
                </div>
              </div>
            )}
            {preview && (
              <details className="document-preview">
                <summary>View uploaded image</summary>
                <img
                  src={preview}
                  alt="Uploaded document preview"
                  onError={() => setPreview("")}
                />
              </details>
            )}
            <div className="review-note">
              <span>i</span>
              <p>
                <strong>Evidence for a human reviewer.</strong> Results are
                signals to investigate, not a final authenticity decision.
              </p>
            </div>
          </section>
        </div>
        <footer>
          <span>
            Insurance AI <b>/</b> Forgery Detection
          </span>
          <span>Research prototype · Admin access · Results saved to your organisation</span>
        </footer>
      </main>
    </div>
  );
}
