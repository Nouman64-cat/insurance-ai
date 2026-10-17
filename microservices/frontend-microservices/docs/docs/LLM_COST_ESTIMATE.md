# LLM Cost Estimate — OpenAI gpt-4o-mini

Estimated API cost per request and per case for the Rizviz insurance-ai platform.

> **Status: estimate, not billing data.** Figures are derived from the actual prompts, tool schemas
> and code paths (token counts measured with the `o200k_base` tokenizer). They were not measured on a
> live run. Real usage is logged per service on the **Token Economy** page — use it to replace the
> assumptions below.

## Assumptions

| Item | Value |
|---|---|
| Model | `gpt-4o-mini` serves **every** call below |
| Input price | $0.15 / 1M tokens |
| Cached input price | $0.075 / 1M tokens |
| Output price | $0.60 / 1M tokens |
| Prices | From memory — **verify on the OpenAI pricing page** |
| Provider setting | In code, Gemini is primary and gpt-4o-mini is the fallback (Super Admin → LLM Configuration). This document prices the case where gpt-4o-mini handles everything. |
| Image tokens | gpt-4o-mini bills a page image as input tokens: 2,833 base + 5,667 per 512px tile (detail `high`/`auto`). An A4 page rendered at 130 dpi ≈ 36.8k tokens; a phone photo ≈ 25.5k. |

## 1. Where the API is used

| # | Place | What it does | Calls |
|---|---|---|---|
| 1 | Chatbot turns (chat-agent) | Every user message or chip click. After a tool runs, control returns to the model to write the reply. | ~2 per action |
| 2 | Chat title generator | Names each chat | 1–2 per chat |
| 3 | Plan advisor (chat) | Suggests a plan for a customer | 1 per use |
| 4 | OCR of case documents (`/extract`, and `/extract/stream`) | Reads each uploaded page or image (vision) | 1 per page |
| 5 | OCR structured extraction (`/extract-structured`) | Pulls medical / income / identity facts from the OCR text | 1 per document |
| 6 | OCR on the Add Customer form (`/extract-customer`) | Fills the form from an uploaded document | 1 per image; up to 3 pages per PDF |
| 7 | Text summarizer | Per-document summary, underwriting summary (Medical / Financial / Occupational), underwriter note | 1 per click |
| 8 | Risk engine scoring | Medical, financial and fraud scoring | 3 per evaluation |
| 9 | Risk engine plan suggestion (`/suggest-plan`) | "Suggest plan" in the customer form | 1 per use |
| 10 | LLM Config "test connection" | 16-token ping | Negligible |
| 11 | Voice assistant | Configured as gpt-4o-mini inside Deepgram's voice agent | Billed through Deepgram, not as direct OpenAI usage |

**Not OpenAI:** the RAG help agent in tenant-service is hard-coded to Gemini (embeddings + `gemini-2.5-flash`).

**No LLM cost in any mode:** e-application, ACR, compliance screening, initial premium payment, insurance
history, medical exam, pre-issuance, policy issuance, activation and post-issuance.

## 2. Cost per single call (input and output separately)

| Component | Input tokens | Output tokens | Input $ | Output $ | Total $ |
|---|---:|---:|---:|---:|---:|
| OCR, one A4 scan page | 37,185 | 800 | 0.00558 | 0.00048 | **0.0061** |
| OCR, one phone photo | 25,851 | 800 | 0.00388 | 0.00048 | 0.0044 |
| OCR, one page at low image detail | 3,183 | 800 | 0.00048 | 0.00048 | 0.0010 |
| Structured extraction | 870 | 80 | 0.00013 | 0.00005 | 0.0002 |
| Customer-form upload, 1 image | 38,071 | 600 | 0.00571 | 0.00036 | 0.0061 |
| Customer-form upload, 3-page PDF | 114,213 | 1,800 | 0.01713 | 0.00108 | 0.0182 |
| Summary, 5 docs (underwriting) | 4,200 | 450 | 0.00063 | 0.00027 | 0.0009 |
| Summary, 5 docs (per-document) | 4,200 | 1,500 | 0.00063 | 0.00090 | 0.0015 |
| Underwriter note | 1,250 | 120 | 0.00019 | 0.00007 | 0.0003 |
| Risk assessment (3 calls) | 5,550 | 1,050 | 0.00083 | 0.00063 | **0.0015** |
| Plan advisor | 2,143 | 150 | 0.00032 | 0.00009 | 0.0004 |
| Chat title | 1,400 | 15 | 0.00021 | 0.00001 | 0.0002 |
| Chat call, uncached | 16,746 | 150 | 0.00251 | 0.00009 | **0.0026** |
| Chat call, prefix cached | 16,746 | 150 | 0.00156 | 0.00009 | 0.0017 |

Prompt sizes behind these numbers:

| Prompt | Tokens |
|---|---:|
| Chat system prompt | ~2,979 |
| Chat tool schemas (43 core tools) | ~9,767 |
| Chat fixed prefix per call | ~12,746 (22.7k if all 99 tools are bound) |
| OCR prompt / customer-extract prompt | 350 / 1,236 |
| Risk system prompts (medical / financial / fraud) | 220 / 136 / 249 |
| Plan-advisor system prompt | 193 |

A chat call = the fixed prefix + conversation history (assumed 5k tokens on average; up to 40 messages are kept) + ~150 output tokens.
OpenAI's automatic prompt caching should discount the stable ~12.7k-token prefix by 50%.

## 3. End-to-end cost per case — manual vs. automation chat

*Manual* = an operator using the portal pages (no chatbot). *Automation chat* = the same LLM work (the chat
triggers the same OCR / summary / risk endpoints) **plus** the chatbot's own calls.

**Low** and **Expected** assume prompt caching works. **High** assumes it does not, longer chats and ~20% retries.

| Case | Mode | Low | **Expected** | High |
|---|---|---:|---:|---:|
| Individual | Manual | $0.022 | **$0.043** | $0.079 |
| Individual | Automation chat | $0.060 | **$0.114** | $0.321 |
| Family, 4 members | Manual | $0.060 | **$0.145** | $0.290 |
| Family, 4 members | Automation chat | $0.169 | **$0.367** | $0.974 |
| Corporate, 50 employees, 10 above the limit | Manual | $0.015 | **$0.315** | $0.469 |
| Corporate, 50 employees, 10 above the limit | Automation chat | $0.055 | **$0.612** | $1.555 |

### Expected case — input vs. output

| Case | Mode | Input tokens | Output tokens | Input $ | Output $ | Total $ |
|---|---|---:|---:|---:|---:|---:|
| Individual | Manual | 248k | 9k | 0.037 | 0.005 | 0.043 |
| Individual | Chat | 954k | 15k | 0.105 | 0.009 | 0.114 |
| Family | Manual | 842k | 32k | 0.126 | 0.019 | 0.145 |
| Family | Chat | 3.03M | 50k | 0.337 | 0.030 | 0.367 |
| Corporate | Manual | 1.86M | 62k | 0.278 | 0.037 | 0.315 |
| Corporate | Chat | 4.79M | 86k | 0.560 | 0.052 | 0.612 |

### What each scenario assumes

**Individual**
- *Manual (Expected):* Add Customer form upload (1 image), 1 plan suggestion, 5 document pages with OCR and
  structured extraction, underwriting summary + per-document summary + 1 underwriter note, and 1.5 risk
  evaluations (a re-run half the time).
- *Chat (Expected):* the same, plus ~40 chat calls for ~18 actions end to end — customer, proposal, case,
  upload, six gates, risk, approve, pre-issuance, issue, payment, activation — at ~2 calls per action, +10% retries.

**Family (4 members)** — one case is created **per member**, for both floater and life-bundle plans.
Risk is not run when members are confirmed; each member is scored when their case is evaluated.
- *Manual (Expected):* 4 form uploads, 4 plan suggestions, 16 document pages (4 per member), 4 summaries, 4 notes, 6 risk evaluations.
- *Chat (Expected):* the same, plus ~123 chat calls (group setup plus four member lifecycles, +10% retries).

**Corporate (50 employees, 10 above the free cover limit)** — employees at or below the limit are
guaranteed issue and cost **no** LLM. Only above-limit employees get a case and an automatic 3-call risk score at census confirm.
- *Manual (Expected):* company documents (5 pages) plus the 10 above-limit cases at ~4 pages each, summaries and notes for each, and 15 risk evaluations (10 automatic + 5 re-runs).
- *Manual (Low):* only the 10 automatic risk scores.
- *Chat (Expected):* the same LLM work, plus ~165 chat calls (census setup plus 5 of the 10 flagged cases handled in chat). It still counts documents for all 10 flagged cases, so it runs slightly high.
- *Chat (Low):* census setup only (~30 calls).
- Rule of thumb: roughly $0.17 base, plus ~$0.0015 per above-limit employee for scoring, plus ~$0.03 if that employee also gets documents.

## 4. Findings

1. **Chat is the biggest cost driver.** It costs 2–3× the manual flow, and ~90% of the extra is the repeated
   ~12.7k-token tool + system prefix sent on every call. Binding fewer tools per turn is the largest saving.
2. **Page images drive manual cost.** Each page is 25–37k input tokens. Setting image detail to `low` cuts OCR
   from ~$0.006 to ~$0.001 per page, at some accuracy cost on small print.
3. **Possible bug if OpenAI is the only configured provider.** Case-document OCR (`/extract`) cannot send PDFs
   to OpenAI, and only the Add Customer upload (`/extract-customer`) converts PDF pages to images. Case PDFs
   would fail OCR and be marked "Re-submission Requested".
4. **Biggest uncertainty:** chat call count and history size. Replace them with measured totals from the Token
   Economy page for one real chat-driven case.

## 5. Updating the numbers

Every figure comes from three inputs: the prices in the Assumptions table, the per-call token counts in section 2,
and the scenario mix in section 3 (how many of each call a case makes). When prices change, or when the Token
Economy page gives real per-service totals, recompute section 3 from those.
