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
  pixel_forensics?: {
    model: string;
    calibrated: boolean;
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

export default function Home() {
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
  const controller = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const check = new AbortController();
    fetch("/api/health", { signal: check.signal })
      .then((r) => setHealth(r.ok ? "online" : "offline"))
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
      const response = await fetch("/api/analyze", {
        method: "POST",
        body: data,
        signal: abort.signal,
      });
      const payload = await response.json().catch(() => null);
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
      setHealth("online");
    } catch (e) {
      setError(
        e instanceof Error && e.name === "AbortError"
          ? "Analysis cancelled. You can start another check."
          : e instanceof Error
            ? e.message
            : "Analysis failed. Please try again.",
      );
    } finally {
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
    <>
      <header className="topbar">
        <a href="/" className="brand">
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
          Public test workspace
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
        <div className="workspace">
          <form onSubmit={analyze} className="setup-panel">
            <div className="panel-heading">
              <span className="step">01</span>
              <div>
                <h2>Prepare your analysis</h2>
                <p>One document, multiple layers of evidence.</p>
              </div>
            </div>
            <fieldset disabled={running}>
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
                  onChange={(e) => setLayer2(e.target.checked)}
                />
              </label>
              {layer2 && (
                <div className="layer-options">
                  <label className="field-label" htmlFor="provider">
                    Model provider
                  </label>
                  <select
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
                  <p>Bundled TruFor model. Runs locally on CPU.</p>
                </div>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="Pixel forensics"
                  checked={layer3}
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
          <span>Research prototype · Public access for testing</span>
        </footer>
      </main>
    </>
  );
}
