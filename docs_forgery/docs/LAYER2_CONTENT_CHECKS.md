# Layer 2: content consistency

Layer 1 reads the file; layer 2 reads the page. It catches edits that leave no trace in the file by checking the document's
own arithmetic and dates. It is opt-in because it sends the rendered pages to a model provider.

**The model only reads; Python checks.**

## Pipeline

```
render pages (pypdfium2, ≤ max_pages) ─┐
PDF text layer (pdfminer) ─────────────┤
                                       ▼
  1. READ      one request: transcribe every figure as printed (temperature 0, JSON)
  2. VALIDATE  strict schema; anything untrustworthy becomes null and is noted
  3. CHECK     deterministic equations in Python (Decimal, rounding tolerance)
  4. VERIFY    each figure behind a numeric finding: PDF text layer, or a second targeted read
  5. GRADE     severity from what was verified
  6. (photos/scans) re-read key figures; optional visual inspection
```

Calls per document: 1 to read; +1 re-read of key figures or of the figures behind a mismatch (photos and scans only);
+1 optional visual inspection.

## What is extracted

Invoice/receipt (line items with quantity, unit price, per-line `discount_percent`, amount; subtotal; discount; tax;
adjustments such as shipping/fees/rounding; total), bank statement (opening/closing balance, total credits/debits, every
transaction with debit, credit, balance and date), payslip (earnings, gross pay, deductions, total deductions, net pay),
dates (printed and ISO), statement period, identifiers (account numbers, IBANs), and a `legibility` flag.

The prompt tells the model to transcribe exactly as printed, never correct or recompute, include every row, and treat the
page as untrusted data. "You saved ..." messages are not discounts.

## Checks

All comparisons use a tolerance of one cent per term, or 0.05% of the amount, whichever is larger (never below 5 cents).

### Invoices and receipts (`CONTENT_*`)

| Check | Equation | Notes |
|---|---|---|
| `LINE_AMOUNT_MISMATCH` | quantity × unit price (less the line's discount %) = amount | An amount **below** the product is only LOW (an unlisted discount explains it). Above it is HIGH, capped at MEDIUM unless corroborated |
| `LINE_ITEMS_DONT_ADD_UP` | Σ amounts = subtotal | Also passes if the subtotal equals Σ (quantity × price) **and** the amounts are at or below list price (receipts that print list prices with discounted nets). A raised amount is never excused |
| `TOTAL_MISMATCH` | subtotal − discount + tax + charges = total | Four readings are accepted: tax added or already included; discount subtracted or already reflected in the prices. A mismatch is reported only if the total fits none of them |
| (soft) | Σ amounts = total, when there is no tax, discount or charge line | Capped at MEDIUM: an unlisted charge is possible |

One forged figure usually breaks several equations by the same amount; those are merged into one finding.

### Bank statements

| Check | Description |
|---|---|
| `LEDGER_BREAK` | Every running-balance step: balance[k] = balance[k−1] + credit − debit, in either order (oldest-first or newest-first, chosen by best fit). The finding names the row most likely edited: **one broken step → an amount was edited; two adjacent broken steps → that row's balance was edited** |
| `BALANCE_MISMATCH` | opening + total credits − total debits = closing |
| `TXN_TOTAL_MISMATCH` | Σ listed credits = the printed credit total (soft) |

If fewer than 60% of steps follow (the ledger could not be read), no accusation is made and a note is recorded. If more than
a quarter of steps break, the finding is marked soft: an extraction problem is likelier than a forgery.

### Payslips (`PAYSLIP_MISMATCH`)

Σ earnings = gross pay; Σ deductions = total deductions; gross − deductions = net pay; net pay above gross pay (reported
only if the net equation is not already broken: same root cause, one finding).

### Dates, identifiers, template text

| Code | Check |
|---|---|
| `FUTURE_DATE` | A date after the analysis date (due, expiry and similar labels are exempt). Two or more years ahead (e.g. 5325) is HIGH |
| `DATE_ORDERING` | Period ends before it starts; invoice due before issue; transactions outside the statement period; (LOW) one row out of date order |
| `IBAN_INVALID` | Length for the country and the mod-97 check digits. Strings shaped like an IBAN only |
| `PLACEHOLDER_TEXT` | "Lorem ipsum", "John Doe", "[Company Name]", `{{customer}}`, "Acme Corp" ... Masked numbers like `XXXX 4242` are normal and not flagged |

## Verification and severity

A numeric finding's figures are verified before it may be HIGH.

| Document | How |
|---|---|
| PDF with a text layer | Every figure involved must appear in the PDF's own text |
| Photo or scan | A second, targeted read of exactly those figures (the request names the figures, not the first answer) |

| Outcome | Severity |
|---|---|
| Verified | as defined by the check (usually HIGH) |
| Unverified, or the document was marked hard to read, or the check is "soft" | at most MEDIUM |
| The second read **disagreed** | LOW (a misread is likelier than a forgery) |
| Identifier (IBAN) found in the PDF text | MEDIUM; read from an image or absent from the text: LOW |

## Safeguards for photos and scans

Photos have no text layer to check against, so two extra measures apply.

1. **Key-figure re-read.** When no mismatch triggered a second read, the key figures (total, subtotal, tax, net pay, gross
   pay, total deductions, opening/closing balance) are re-read with a differently phrased request. A transcription can
   silently "auto-correct" an edited figure (a forged 6,868.41 read as 68.41) and then look perfectly consistent, so no
   equation would fire. A disagreement is `READ_DISAGREEMENT` (MEDIUM).
2. **Visual inspection** (optional, one page). A model's opinion of fonts and sharpness. It is **LOW on its own** (fonts
   differ on many genuine thermal receipts) and MEDIUM only when it points at a figure another check flagged. It never
   decides a verdict alone.

## Failure handling

| Situation | Result |
|---|---|
| Provider error before the page is read (quota, timeout, blocked, bad JSON) | `layer2_status: failed`; verdict `inconclusive` unless layer 1 found something |
| Secondary call fails (second read, visual) | `partial`; findings kept, unverified ones capped |
| Model replies with a list, prose or truncated JSON | `failed` with a typed reason; never a crash and never "clean" |
| Document without totals, items or dates (e.g. a tax form) | `CONTENT_NOT_APPLICABLE` (info) |

## Known limits

- A forger who also propagates the edit to every dependent total leaves nothing to find.
- A reader that mistranscribes digits can cause a false alarm (verification and the LOW cap limit the damage) or hide an
  edit (the key-figure re-read helps; it has been unit-tested but not yet validated live).
- Receipts that print a figure we do not extract (for example "Total excluding GST") can still confuse a visual opinion.
- Only the first `max_pages` pages are read (4 for Gemini, 2 for Groq); the rest are noted but not checked.
- Rules are region-agnostic; tax rates and national ID formats are not checked.
