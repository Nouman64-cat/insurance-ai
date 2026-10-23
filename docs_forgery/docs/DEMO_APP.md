# Demo app (Streamlit)

A local web UI over the same package: upload documents, see a verdict, the findings, and what layer 2 read.

```powershell
pip install -r requirements-app.txt
streamlit run app.py          # http://localhost:8501
```

## Security

- **Local only.** `.streamlit/config.toml` binds the server to `localhost`. The app has **no login** and layer 2 can spend
  API quota and handle customer documents: do not expose it on a network or the internet.
- Uploads are analysed **in memory** and never written to disk. The only file the app writes is the model-call log
  (`data/demo_calls.jsonl`: status, seconds, tokens, model; no document content).
- Layer 2 is **off by default**. Turning it on requires choosing a provider and ticking a consent box that says the pages are
  sent to that provider. With the box unticked no model client is even created.

## Using it

1. Optionally choose the document type (bank statements are held to a stricter standard).
2. Upload one or more PDFs or images and click **Analyse uploaded documents**, or try a sample (the ground truth is shown
   after the analysis).
3. Each result shows a verdict banner, a page preview, the findings to read first, and three tabs:
   - **All findings**, with evidence for MEDIUM and above;
   - **What Layer 2 read**: the figures, line items, transactions, earnings and deductions the model transcribed;
   - **Technical details**: errors and notes, the model-call table (step, result, seconds, time waited, tokens, model) and a
     JSON report download.
4. Several results produce a summary table at the top.

Verdict wording is deliberately cautious: "No evidence of tampering found" always carries "this is not proof the document is
genuine". A failed layer 2 is shown as "Could not be fully checked", never as clean.

## Notes

- A batch test and the app share a provider's rate allowance. If a test run used the same provider in the last four minutes
  the sidebar warns you.
- Layer 2 on the free tier takes about a minute per document (Groq) because of per-minute token limits. See
  [PROVIDERS_AND_LIMITS.md](PROVIDERS_AND_LIMITS.md).
- The model client is cached for the server's lifetime so its rate limiter remembers earlier requests.

## Structure and tests

`app.py` is the UI; `docforensics/demo.py` holds the logic that needs no Streamlit (formatting, provider status, previews,
sample loading), so it is unit-tested directly. `tests/test_demo.py` also drives the real app headlessly with Streamlit's
`AppTest`: loading, the upload flow, consent gating, layer 2 with a scripted fake model, and a layer-2 outage.
