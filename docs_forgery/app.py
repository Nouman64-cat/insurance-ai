"""Document Forensics demo.   Run:  streamlit run app.py

Upload a payslip, bank statement, invoice or receipt (PDF or image). Layer 1 (file and metadata checks) always runs on
this machine. Layer 2 (reading the page and checking the numbers) is opt-in because it sends the pages to a model provider.
Uploads are analysed in memory and never written to disk.
"""

from __future__ import annotations

import time
from datetime import datetime

import streamlit as st

from docforensics import Analysis, Layer2Options, analyze_document
from docforensics import demo
from docforensics.gemini_client import make_client
from docforensics.report import Severity, Verdict

st.set_page_config(page_title="Document Forensics", page_icon="🔎", layout="wide")

DOC_TYPES = {"Auto-detect": None, "Payslip": "payslip", "Bank statement": "bank_statement", "Invoice": "invoice",
             "Receipt": "receipt", "Other": "other"}
UPLOAD_TYPES = ["pdf", "jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp", "gif"]


@st.cache_resource(show_spinner=False)
def llm_client(provider: str, interval: float):
    """One client per provider for the whole server, so its rate limiter remembers earlier requests."""
    return make_client(provider, min_interval_s=interval, call_log=str(demo.DEMO_CALL_LOG))


st.session_state.setdefault("results", [])


# ---------------------------------------------------------------------------
# Sidebar: what to run
# ---------------------------------------------------------------------------

with st.sidebar:
    st.header("Checks")
    doc_label = st.selectbox("Document type", list(DOC_TYPES), key="doc_type",
                             help="Optional. Bank statements are held to a stricter standard (banks do not issue them from Word or Canva).")
    st.markdown("**Layer 1 · file and metadata**  \nAlways on. Runs on this machine; nothing leaves it.")
    use_l2 = st.toggle("Layer 2 · read the page and check the numbers", key="use_l2", value=False,
                       help="An AI model transcribes the page; Python then checks totals, running balances, dates and IBANs.")
    provider, visual, layer2_on = None, True, False
    if use_l2:
        status = demo.provider_status()
        available = [k for k, v in status.items() if v["has_key"]]
        if not available:
            st.error("No API key found. Add GROQ_API_KEY or GEMINI_API_KEY to the .env file.")
        else:
            provider = st.radio("Model that reads the page", available, key="provider",
                                format_func=lambda k: f"{status[k]['label']} · {status[k]['model']}")
            info = demo.PROVIDERS[provider]
            st.caption(info.note)
            visual = st.checkbox("Also look for visibly edited figures", value=True, key="visual",
                                 help="One extra call. A model's opinion of the image: weak evidence, never decides alone.")
            st.caption("Per document: 1 call to read the page, +1 to re-read key figures on photos and scans, "
                       f"+1 for the visual look. Expect about a minute on {info.label}'s free tier.")
            consent = st.checkbox(f"I understand the document pages are sent to {info.label}", key="consent")
            layer2_on = consent
            if not consent:
                st.info("Tick the box to enable Layer 2. Without it only Layer 1 runs.")
            if provider in demo.active_test_runs():
                st.warning(f"A batch test is using {info.label} right now. Layer 2 may be slow or rate-limited until it finishes.")
    st.divider()
    st.caption("Results show evidence, not proof. 'No evidence' never means authentic: send anything flagged to a person.")


# ---------------------------------------------------------------------------
# Running an analysis
# ---------------------------------------------------------------------------

def analyse(name: str, data: bytes, truth: str | None = None) -> None:
    doc_type = DOC_TYPES[doc_label]
    client = options = None
    if layer2_on and provider:
        client = llm_client(provider, demo.PROVIDERS[provider].min_interval_s)
        options = Layer2Options(visual=visual, max_pages=demo.PROVIDERS[provider].max_pages)
    with st.status(f"Analysing {name}…", expanded=True) as box:
        box.write("Layer 1: checking the file, metadata, edit history and layout…")
        started = time.time()
        analysis = analyze_document(data, name, doc_type, layer2=layer2_on and client is not None, client=client, options=options)
        if analysis.layer2 is not None or analysis.report.layer2_status:
            box.write(f"Layer 2: {analysis.report.layer2_status}.")
        elapsed = time.time() - started
        box.update(label=f"{name}: {demo.VERDICTS[analysis.report.verdict][1]}", state="complete", expanded=False)
    st.session_state.results.insert(0, {
        "name": name, "analysis": analysis, "seconds": elapsed, "when": datetime.now().strftime("%H:%M:%S"),
        "previews": demo.thumbnails(data, analysis.report.file_type), "truth": truth,
        "layer2_requested": layer2_on and client is not None,
        "provider": f"{demo.PROVIDERS[provider].label}" if (layer2_on and provider) else None,
    })


# ---------------------------------------------------------------------------
# Rendering a result
# ---------------------------------------------------------------------------

def render(res: dict, index: int) -> None:
    analysis: Analysis = res["analysis"]
    report = analysis.report
    level, title, blurb = demo.VERDICTS[report.verdict]
    with st.container(border=True):
        st.subheader(res["name"])
        bits = [report.file_type.upper(), f"{report.size:,} bytes", f"sha256 {report.sha256[:12]}…", f"{res['seconds']:.1f}s",
                "Layer 1" + (f" + Layer 2 ({res['provider']}: {report.layer2_status})" if res["layer2_requested"] else " only")]
        st.caption(" · ".join(bits))
        left, right = st.columns([1, 2], gap="large")
        with left:
            for page in res["previews"]:
                st.image(page, width="stretch")
            if not res["previews"]:
                st.caption("No preview available for this file.")
        with right:
            getattr(st, level)(f"**{title}**\n\n{blurb}")
            if report.verdict is Verdict.INCONCLUSIVE or report.incomplete:
                for e in report.errors[:4]:
                    st.caption(f"• {e}")
            top = demo.headline_findings(report)
            if top:
                st.markdown("**Read these first**")
                for f in top:
                    st.markdown(f"{demo.SEVERITY_ICON[f.severity]} **{f.title}**  \n{f.detail}")
            counts = demo.severity_counts(report)
            if counts:
                cols = st.columns(len(counts))
                for col, (name, n) in zip(cols, counts.items()):
                    col.metric(name, n)
            if res["truth"]:
                st.caption(f"🧪 {res['truth']}")

        tabs = st.tabs(["All findings", "What Layer 2 read", "Technical details"])
        with tabs[0]:
            show_info = st.checkbox("Include informational notes", key=f"info_{index}")
            rows = demo.findings_rows(report, include_info=show_info)
            if rows:
                st.dataframe(rows, hide_index=True, width="stretch", column_config={
                    "Detail": st.column_config.TextColumn(width="large"), "Finding": st.column_config.TextColumn(width="medium")})
            else:
                st.caption("No findings above informational level.")
            for f in report.sorted_findings():
                if f.severity >= Severity.MEDIUM and f.evidence:
                    with st.expander(f"Evidence: {f.title}"):
                        st.json(f.evidence)
        with tabs[1]:
            seen = demo.figures(analysis)
            if not seen:
                st.caption("Layer 2 was not run for this document." if not res["layer2_requested"]
                           else "Layer 2 could not read this document; see the technical details.")
            else:
                st.caption(f"Read as **{seen['doc_type']}**"
                           + (f" · currency {seen['currency']}" if seen["currency"] else "") + f" · legibility {seen['legibility']}")
                if seen["scalars"]:
                    cols = st.columns(min(len(seen["scalars"]), 5))
                    for i, (k, v) in enumerate(seen["scalars"].items()):
                        cols[i % len(cols)].metric(k.replace("_", " ").title(), v)
                for label, key in (("Line items", "items"), ("Transactions", "transactions"), ("Earnings", "earnings"),
                                   ("Deductions", "deductions")):
                    if seen[key]:
                        st.markdown(f"**{label}**")
                        st.dataframe(seen[key], hide_index=True, width="stretch")
        with tabs[2]:
            if report.errors:
                st.markdown("**Notes and errors**")
                for e in report.errors:
                    st.code(e, language=None)
            calls = demo.calls_rows(analysis)
            if calls:
                st.markdown("**Model calls**")
                st.dataframe(calls, hide_index=True, width="stretch")
            st.download_button("Download full report (JSON)", demo.report_json(analysis, {"truth": res["truth"]}),
                               file_name=f"{res['name']}.report.json", mime="application/json", key=f"dl_{index}")


# ---------------------------------------------------------------------------
# Page
# ---------------------------------------------------------------------------

st.title("🔎 Document Forensics")
st.caption("Checks customer-submitted documents for edits, manipulation and machine generation, without needing the "
           "issuer's template. Upload payslips, bank statements, invoices or receipts.")

files = st.file_uploader("Upload documents (PDF or image)", type=UPLOAD_TYPES, accept_multiple_files=True, key="uploads")
c1, c2, _ = st.columns([1, 1, 3])
if c1.button("Analyse uploaded documents", type="primary", disabled=not files, key="analyze_uploads"):
    for f in files:
        analyse(f.name, f.getvalue())
if c2.button("Clear results", disabled=not st.session_state.results, key="clear"):
    st.session_state.results = []
    st.rerun()

samples = demo.load_samples()
if samples:
    with st.expander("No document handy? Try a sample"):
        st.caption("Real and synthetic documents, some untouched and some edited. The ground truth is revealed after the analysis.")
        pick = st.selectbox("Sample", range(len(samples)), format_func=lambda i: demo.sample_title(samples[i]), key="sample")
        if st.button("Analyse this sample", key="analyze_sample"):
            entry = samples[pick]
            analyse(entry["path"], (demo.SAMPLES_DIR / entry["path"]).read_bytes(), demo.truth_text(entry))

results = st.session_state.results
if results:
    st.divider()
    if len(results) > 1:
        st.subheader("Summary")
        st.dataframe([{"Document": r["name"], "Verdict": demo.VERDICTS[r["analysis"].report.verdict][1],
                       "Findings (medium+)": len(demo.headline_findings(r["analysis"].report, 99)),
                       "Layer 2": r["analysis"].report.layer2_status or "off", "Time": r["when"]} for r in results],
                     hide_index=True, width="stretch")
    for i, res in enumerate(results):
        render(res, i)
