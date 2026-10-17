"""The application dossier: everything the customer gave us, in one short PDF.

Order:
  1. Application information: customer profile, the e-application, the medical examination.
  2. The proposal: plan, cover, premium, nominees, advisor; then everything else recorded about the customer.
  3. Scans of the customer's medical reports.
  4. Scans of the personal documents the plan requires.
  5. How to register a claim (one to two pages).
  6. Policy rules: maturity, surrender, return (free-look) and reinstatement.

It is kept short on purpose. Every medical report is included, one per test; each uploaded PDF contributes at most
1 page (medical reports, one per test) or MAX_PAGES_PER_FILE pages (personal documents); the index says when one was cut; only the latest usable upload per document type is used.
It is rebuilt whenever a policy's documents are generated. A file that cannot be read is listed as "not included"
instead of stopping the dossier.
"""

import asyncio
import hashlib
import html
import io
import logging
import os
from datetime import datetime
from typing import Any, List, Optional, Tuple

from PIL import Image
from pypdf import PdfReader, PdfWriter
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from services import document_generator as dg
from shared.models.core import (
    Artifact, Case, Customer, CustomerEApplication, InsurancePlan, MedicalExamOrder, Policy, PolicyDocument,
    PolicyDocumentTypeEnum, Tenant,
)
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

log = logging.getLogger(__name__)

_STORAGE = "/app/shared/storage"
_S3_BUCKET = os.environ.get("S3_BUCKET_NAME", "insurance-ai-dev")
_E = html.escape
MAX_PAGES_PER_FILE = 2

# ── Look and feel ────────────────────────────────────────────────────────────────────────────────────────────────
# Navy for headings and bars, the insurer's blue and green (from its logo) as accents, soft blue-grey for tables.
_ASSETS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "brand")
_NAVY = colors.HexColor("#0b2e5c")
_BLUE = colors.HexColor("#0b63ce")
_GREEN = colors.HexColor("#2f9e57")
_INK = colors.HexColor("#1e293b")
_MUTE = colors.HexColor("#64748b")
_LABEL_BG = colors.HexColor("#eaf1fb")
_ZEBRA = colors.HexColor("#f6f9fd")
_RULE = colors.HexColor("#d3deec")
# What the customer calls this document. Adamjee Life's own wording for the pack a new policyholder receives is
# "policy documents"; this one is the record of the application behind the policy, so it is named for that.
DOCUMENT_TITLE = "Policy Application Record"
_PAGE_W, _PAGE_H = A4
_MARGIN_X = 20 * mm
_CONTENT_W = _PAGE_W - 2 * _MARGIN_X
_TOP_MARGIN = 36 * mm
_BOTTOM_MARGIN = 24 * mm


def _styles():
    ss = getSampleStyleSheet()
    ss.add(ParagraphStyle("Body", parent=ss["Normal"], textColor=_INK, fontSize=9.5, leading=14, spaceAfter=2))
    ss.add(ParagraphStyle("Cell", parent=ss["Normal"], textColor=_INK, fontSize=9.2, leading=13))
    ss.add(ParagraphStyle("CellLabel", parent=ss["Normal"], textColor=_NAVY, fontSize=8.8, leading=12, fontName="Helvetica-Bold"))
    ss.add(ParagraphStyle("Fine", parent=ss["Normal"], textColor=_MUTE, fontSize=8, leading=11))
    ss.add(ParagraphStyle("Sec", parent=ss["Normal"], textColor=colors.white, fontSize=12, leading=15, fontName="Helvetica-Bold"))
    ss.add(ParagraphStyle("H", parent=ss["Normal"], textColor=_BLUE, fontSize=10.5, leading=14, fontName="Helvetica-Bold",
                          spaceBefore=10, spaceAfter=4, keepWithNext=1))
    ss.add(ParagraphStyle("CoverTitle", parent=ss["Normal"], textColor=_NAVY, fontSize=26, leading=31, fontName="Helvetica-Bold",
                          alignment=TA_CENTER))
    ss.add(ParagraphStyle("CoverSub", parent=ss["Normal"], textColor=_MUTE, fontSize=11.5, leading=16, alignment=TA_CENTER))
    return ss


def _section(ss, number: int, title: str) -> Table:
    """A numbered section band: navy with a green edge, kept on the same page as what follows it."""
    t = Table([[Paragraph(f"{number}&nbsp;&nbsp;&nbsp;{_E(title)}", ss["Sec"])]], colWidths=[_CONTENT_W])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), _NAVY),
        ("LINEBEFORE", (0, 0), (0, -1), 4, _GREEN),
        ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    t.spaceBefore = 12
    t.spaceAfter = 6
    t.keepWithNext = True
    return t


def _kv_table(rows: List[Tuple[str, str]]) -> Table:
    """Label / value rows: shaded label column, soft borders. Values are already escaped."""
    ss = _styles()
    data = [[Paragraph(k, ss["CellLabel"]), Paragraph(v, ss["Cell"])] for k, v in rows]
    t = Table(data, colWidths=[52 * mm, _CONTENT_W - 52 * mm])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 0), (0, -1), _LABEL_BG),
        ("ROWBACKGROUNDS", (1, 0), (1, -1), [colors.white, _ZEBRA]),
        ("BOX", (0, 0), (-1, -1), 0.6, _RULE),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, _RULE),
        ("LINEAFTER", (0, 0), (0, -1), 0.4, _RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    t.spaceAfter = 4
    return t


def _logo(c, name: str, x: float, y: float, height: float, align: str = "left") -> None:
    """Draw a brand logo with its bottom edge at y. Missing files are skipped: the dossier never fails over a logo."""
    path = os.path.join(_ASSETS, name)
    if not os.path.isfile(path):
        return
    try:
        img = ImageReader(path)
        iw, ih = img.getSize()
        w = height * iw / ih
        c.drawImage(img, x - (w if align == "right" else 0), y, w, height, mask="auto")
    except Exception:
        log.warning("dossier: could not draw logo %s", name, exc_info=True)


def _page_frame(meta: dict):
    """Header (both logos over a blue rule) and footer (document, confidentiality, contact) for every generated page."""
    def draw(c, doc):
        c.saveState()
        top = _PAGE_H - 8 * mm
        _logo(c, "adamjee-life.png", _MARGIN_X, top - 17 * mm, 17 * mm)
        _logo(c, "getinsuredai.png", _PAGE_W - _MARGIN_X, top - 14 * mm, 14 * mm, align="right")
        y = _PAGE_H - 28 * mm
        c.setStrokeColor(_BLUE)
        c.setLineWidth(1.6)
        c.line(_MARGIN_X, y, _PAGE_W - _MARGIN_X, y)
        c.setStrokeColor(_GREEN)
        c.setLineWidth(1.6)
        c.line(_MARGIN_X, y, _MARGIN_X + 28 * mm, y)
        # Footer
        fy = 16 * mm
        c.setStrokeColor(_RULE)
        c.setLineWidth(0.6)
        c.line(_MARGIN_X, fy, _PAGE_W - _MARGIN_X, fy)
        c.setFillColor(_NAVY)
        c.setFont("Helvetica-Bold", 7.5)
        c.drawString(_MARGIN_X, fy - 4.5 * mm, f"{DOCUMENT_TITLE}  |  Policy {meta['policy_number']}")
        c.setFillColor(_MUTE)
        c.setFont("Helvetica", 7)
        c.drawString(_MARGIN_X, fy - 8.5 * mm, f"Confidential: prepared for {meta['customer_name']}. Please keep this document in a safe place.")
        if meta.get("contact"):
            c.drawRightString(_PAGE_W - _MARGIN_X, fy - 4.5 * mm, meta["contact"])
        c.restoreState()
    return draw


def _build_doc(path: str, story: list, meta: dict) -> None:
    doc = SimpleDocTemplate(path, pagesize=A4, leftMargin=_MARGIN_X, rightMargin=_MARGIN_X,
                            topMargin=_TOP_MARGIN, bottomMargin=_BOTTOM_MARGIN,
                            title=DOCUMENT_TITLE, author=meta.get("tenant_name") or "")
    frame = _page_frame(meta)
    doc.build(story, onFirstPage=frame, onLaterPages=frame)


def _number_pages(writer: PdfWriter) -> None:
    """'Page x of y' on every page of the finished dossier, scans included (the generated sections are built apart)."""
    total = len(writer.pages)
    for n, page in enumerate(writer.pages, 1):
        w, h = float(page.mediabox.width), float(page.mediabox.height)
        buf = io.BytesIO()
        c = rl_canvas.Canvas(buf, pagesize=(w, h))
        c.setFillColor(_NAVY)
        c.setFont("Helvetica-Bold", 7.5)
        c.drawRightString(w - _MARGIN_X, 7.5 * mm, f"Page {n} of {total}")
        c.save()
        page.merge_page(PdfReader(io.BytesIO(buf.getvalue())).pages[0])


def _s(v: Any) -> str:
    if v is None or v == "":
        return "—"
    if isinstance(v, bool):
        return "Yes" if v else "No"
    return _E(str(v))


def _fetch(artifact: Artifact) -> Optional[bytes]:
    """The stored file's bytes: local storage first, then S3. None if it cannot be read."""
    url = artifact.storage_url or ""
    keys: List[str] = []
    if url.startswith("local://"):
        keys.append(url.replace("local://", ""))
    elif ".amazonaws.com/" in url:
        keys.append(url.split(".amazonaws.com/", 1)[-1])
    elif url:
        keys.append(url)
    for k in keys:
        path = os.path.join(_STORAGE, k)
        if os.path.isfile(path):
            with open(path, "rb") as f:
                return f.read()
    try:
        import boto3
        access = os.getenv("AWS_ACCESS_KEY_ID", "")
        if keys and access and "your_aws_access_key" not in access:
            from botocore.config import Config
            client = boto3.client("s3", region_name=os.getenv("AWS_REGION", "us-east-1"),
                                  config=Config(connect_timeout=5, read_timeout=15, retries={"max_attempts": 1}))
            return client.get_object(Bucket=_S3_BUCKET, Key=keys[0])["Body"].read()
    except Exception:
        log.warning("could not fetch %s", artifact.file_name, exc_info=True)
    return None


def _image_pdf(data: bytes, title: str) -> bytes:
    """One A4 page with the image scaled to fit under a caption."""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    from reportlab.lib.utils import ImageReader

    img = Image.open(io.BytesIO(data))
    img = img.convert("RGB")
    buf = io.BytesIO()
    w, h = A4
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("Helvetica-Bold", 11)
    c.setFillColor(_NAVY)
    c.drawString(18 * mm, h - 16 * mm, title[:90])
    box_w, box_h = w - 36 * mm, h - 40 * mm
    iw, ih = img.size
    scale = min(box_w / iw, box_h / ih)
    dw, dh = iw * scale, ih * scale
    c.drawImage(ImageReader(img), 18 * mm, h - 24 * mm - dh, dw, dh)
    c.showPage()
    c.save()
    return buf.getvalue()


def _stamp(page, label: str) -> None:
    """Print a label bar across the top of an attached PDF page, so every page says what it is."""
    from reportlab.pdfgen import canvas
    w, h = float(page.mediabox.width), float(page.mediabox.height)
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(w, h))
    c.setFillColor(_NAVY)
    c.rect(0, h - 9 * mm, w, 9 * mm, stroke=0, fill=1)
    c.setFillColor(_GREEN)
    c.rect(0, h - 9.8 * mm, w, 0.8 * mm, stroke=0, fill=1)
    c.setFillColorRGB(1, 1, 1)
    c.setFont("Helvetica-Bold", 9.5)
    c.drawString(10 * mm, h - 6 * mm, label[:110])
    c.save()
    page.merge_page(PdfReader(io.BytesIO(buf.getvalue())).pages[0])


def _kv(rows: List[Tuple[str, Any]]):
    return _kv_table([(_E(k), _s(v)) for k, v in rows])


_CONTENTS = [
    ("1", "Customer Profile"), ("2", "Policy Applied For"), ("3", "Customer E-Application"), ("4", "Medical Examination"),
    ("5", "Proposal"), ("6", "Customer Information Collected"), ("7", "Attached Scans and Policy Wording"),
    ("8", "How to Register a Claim"), ("9", "Policy Rules"),
]


def _cover_story(ss, customer: Customer, policy: Policy, tenant_name: str, ctx: dict) -> list:
    """The first page: what this document is, whose policy it covers, and what is inside."""
    story: list = [Paragraph(DOCUMENT_TITLE, ss["CoverTitle"]),
                   Spacer(1, 3 * mm),
                   Paragraph(_E(f"A complete record of your application with {tenant_name}"), ss["CoverSub"]),
                   Spacer(1, 12 * mm)]
    summary = [
        ("Policyholder", customer.name), ("Policy number", policy.policy_number or "Not yet issued"),
        ("Plan", policy.product_name), ("Sum assured", dg._pkr(policy.coverage_amount)),
        ("Policy term", f"{policy.term_years} years"),
        ("Commencement", ctx.get("effective_date")), ("Prepared on", f"{datetime.utcnow():%d %B %Y}"),
    ]
    story.append(_kv(summary))
    story.append(Spacer(1, 10 * mm))
    story.append(Paragraph("What is inside", ss["H"]))
    rows = [[Paragraph(n, ss["CellLabel"]), Paragraph(_E(t), ss["Cell"])] for n, t in _CONTENTS]
    t = Table(rows, colWidths=[12 * mm, _CONTENT_W - 12 * mm])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TEXTCOLOR", (0, 0), (0, -1), _GREEN),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, _RULE),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(t)
    story.append(Spacer(1, 10 * mm))
    story.append(Paragraph(_E(
        f"This record is issued with your policy. It contains the information you gave us, the terms we agreed and the "
        f"documents we hold, so you have everything in one place. If anything is incorrect, please contact {tenant_name} "
        f"using the details at the foot of each page."), ss["Fine"]))
    story.append(PageBreak())
    return story


def _info_story(ss, customer: Customer, policy: Policy, tenant_name: str, eapp: Optional[CustomerEApplication],
                med: Optional[MedicalExamOrder]) -> list:
    story: list = []
    d = customer.details or {}
    contact, addr = d.get("contact") or {}, d.get("address") or {}
    story.append(_section(ss, 1, "Customer Profile"))
    story.append(_kv([
        ("Name", customer.name), ("CNIC", customer.cnic), ("Date of birth", customer.dob),
        ("Gender", getattr(customer.gender, "value", customer.gender)),
        ("Marital status", getattr(customer.marital_status, "value", customer.marital_status)),
        ("Occupation", customer.occupation), ("Declared income", customer.declared_income),
        ("Mobile", contact.get("mobile_number")), ("Email", contact.get("email")),
        ("Address", ", ".join(str(x) for x in (addr.get("street_address"), addr.get("area"), addr.get("city"),
                                               addr.get("province")) if x)),
        ("Height / weight", f"{customer.height_cm or '—'} cm / {customer.weight_kg or '—'} kg"),
        ("Smoker", customer.is_smoker),
    ]))
    story.append(_section(ss, 2, "Policy Applied For"))
    story.append(_kv([
        ("Product", policy.product_name), ("Sum assured", policy.coverage_amount),
        ("Term", f"{policy.term_years} years"), ("Policy number", policy.policy_number),
    ]))

    story.append(PageBreak())
    story.append(_section(ss, 3, "Customer E-Application"))
    if eapp is None or not (eapp.medical_questionnaire or eapp.declaration):
        story.append(Paragraph("The customer did not complete an e-application.", ss["Body"]))
    else:
        mq = eapp.medical_questionnaire or {}
        story.append(Paragraph("Medical & Health", ss["H"]))
        story.append(_kv([
            ("Height", f"{mq.get('height_cm')} cm" if mq.get("height_cm") else None),
            ("Weight", f"{mq.get('weight_kg')} kg" if mq.get("weight_kg") else None),
            ("Tobacco / nicotine", mq.get("tobacco_use")),
        ]))
        conds = [c for c in (mq.get("conditions") or []) if c.get("checked")]
        if conds:
            for c in conds:
                story.append(Spacer(1, 4))
                story.append(_kv([
                    ("Condition", c.get("label")), ("Year of diagnosis", c.get("year_of_diagnosis")),
                    ("Under treatment", c.get("under_treatment")), ("Medications", c.get("medications")),
                    ("Physician", f"{c.get('physician_name') or '—'} {c.get('physician_clinic') or ''}".strip()),
                ]))
        else:
            story.append(Paragraph("No medical conditions declared.", ss["Body"]))
        for q in mq.get("custom_questions") or []:
            story.append(Paragraph(f"<b>{_E(str(q.get('question') or ''))}</b> — {_s(q.get('answer'))}", ss["Body"]))

        story.append(Paragraph("Family History", ss["H"]))
        fam = (eapp.family_history or {}).get("entries") or []
        if fam:
            for f in fam:
                story.append(Paragraph(
                    f"{_s(f.get('relation'))} · age {_s(f.get('age'))} · "
                    f"{'living' if f.get('is_alive') else 'deceased'} · {_s(f.get('condition') or 'healthy')}", ss["Body"]))
        else:
            story.append(Paragraph("No family history recorded.", ss["Body"]))

        ls = eapp.lifestyle_habits or {}
        story.append(Paragraph("Lifestyle & Travel", ss["H"]))
        story.append(_kv([
            ("Hazardous hobbies", ls.get("has_hazardous_hobby")), ("Hobby details", ls.get("hazardous_hobby_details")),
            ("Occupation hazard", ls.get("occupation_hazard_level")),
            ("Frequent foreign travel", ls.get("frequent_foreign_travel")),
            ("Traffic violations (3 yrs)", ls.get("moving_violations_past_3_years")),
        ]))
        story.append(Paragraph("Existing Insurance", ss["H"]))
        pols = (eapp.existing_insurance or {}).get("policies") or []
        if pols:
            for p in pols:
                story.append(Paragraph(
                    f"{_s(p.get('insurer_name'))} · policy {_s(p.get('policy_number'))} · "
                    f"sum assured {_s(p.get('sum_assured'))} · {_s(p.get('status'))}", ss["Body"]))
        else:
            story.append(Paragraph("No existing insurance declared.", ss["Body"]))
        story.append(Paragraph("Declaration", ss["H"]))
        story.append(_kv([
            ("Typed signature", (eapp.declaration or {}).get("signature_name")),
            ("Submitted", eapp.submitted_at), ("Verified", eapp.verified_at),
        ]))

    story.append(_section(ss, 4, "Medical Examination"))
    if med is None or getattr(med.status, "value", med.status) in ("NotAssessed", "NotRequired"):
        story.append(Paragraph("No medical examination was required.", ss["Body"]))
    else:
        story.append(_kv([
            ("Status", getattr(med.status, "value", med.status)), ("Appointment", med.appointment_at),
            ("Outcome", getattr(med.outcome, "value", med.outcome) if med.outcome else None),
            ("Completed", med.completed_at), ("Reported by", med.reported_by),
        ]))
        story.append(Paragraph("Tests", ss["H"]))
        for t in med.required_tests or []:
            story.append(Paragraph(f"• {_s(t.get('name'))} ({_s(t.get('category'))})", ss["Body"]))
        if med.results_json:
            story.append(Paragraph("Results", ss["H"]))
            for code, r in med.results_json.items():
                if isinstance(r, dict):
                    story.append(Paragraph(
                        f"<b>{_E(str(code))}</b>: {_s(r.get('value'))} {_s(r.get('unit')) if r.get('unit') else ''} "
                        f"(ref {_s(r.get('reference_range'))}) {_s(r.get('flag'))}", ss["Body"]))
                else:
                    story.append(Paragraph(f"<b>{_E(str(code))}</b>: {_s(r)}", ss["Body"]))
        for f in med.abnormal_findings or []:
            story.append(Paragraph(f"• {_s(f)}", ss["Body"]))


    return story

_SECTION_TITLES = [
    ("cnic_metadata", "Identity (CNIC)"), ("address", "Address"), ("contact", "Contact"),
    ("occupation_details", "Occupation & Employer"), ("income_record", "Income"), ("beneficiary", "Nominee Details"),
    ("medical_history", "Medical History"), ("lifestyle", "Lifestyle & Habits"), ("habit_check", "Habit Check"),
    ("financial_records", "Financial Records"),
]


def _flatten(value: Any, prefix: str = "") -> List[Tuple[str, Any]]:
    """Nested customer details as readable rows; empty values and the bookkeeping flags are left out."""
    rows: List[Tuple[str, Any]] = []
    if isinstance(value, dict):
        for k, v in value.items():
            if k.startswith("is_") and k in ("is_primary", "is_verified"):
                continue
            label = (prefix + " " + k.replace("_", " ")).strip()
            rows += _flatten(v, label)
    elif isinstance(value, list):
        if value and all(not isinstance(x, (dict, list)) for x in value):
            rows.append((prefix, ", ".join(str(x) for x in value)))
        else:
            for n, x in enumerate(value, 1):
                rows += _flatten(x, f"{prefix} {n}")
    elif value not in (None, "", 0, 0.0, False, []):
        rows.append((prefix, value))
    return rows


def _details_story(ss, customer: Customer) -> list:
    """Everything recorded about the customer at registration, section by section."""
    details = customer.details or {}
    story: list = [PageBreak(), _section(ss, 6, "Customer Information Collected")]
    shown = False
    for key, title in _SECTION_TITLES:
        rows = _flatten(details.get(key))
        if rows:
            shown = True
            story.append(Paragraph(title, ss["H"]))
            story.append(_kv([(k.capitalize(), v) for k, v in rows]))
    for key, title in (("conditions", "Medical Conditions"), ("family_history", "Family History (registration)")):
        rows = _flatten(details.get(key))
        if rows:
            shown = True
            story.append(Paragraph(title, ss["H"]))
            story.append(_kv([(k.capitalize(), v) for k, v in rows]))
    if not shown:
        story.append(Paragraph("No further details were recorded at registration.", ss["Body"]))
    return story


def _proposal_story(ss, ctx: dict) -> list:
    pb = ctx.get("premium_breakdown") or {}
    story: list = [PageBreak(), _section(ss, 5, "Proposal")]
    story.append(_kv([
        ("Applicant", ctx.get("customer_name")), ("Product", ctx.get("product_name")),
        ("Plan type", ctx.get("insurance_type")), ("Sum assured", dg._pkr(ctx.get("coverage_amount"))),
        ("Policy term", f"{ctx.get('term_years')} years"), ("Premium frequency", ctx.get("billing_frequency")),
        ("Commencement", ctx.get("effective_date")), ("Expiry", ctx.get("expiry_date")),
        ("Advisor / agent", ctx.get("agent_name")),
    ]))
    story.append(Paragraph("Premium", ss["H"]))
    story.append(_kv([
        ("Base premium", dg._pkr(pb.get("base_premium"))), ("Underwriting loading", dg._pkr(pb.get("loading_amount"))),
        ("Policy fee", dg._pkr(pb.get("policy_fee"))), ("Stamp duty", dg._pkr(pb.get("stamp_duty_amount"))),
        ("Sales tax", dg._pkr(pb.get("tax_amount"))), ("Total first premium", dg._pkr(pb.get("total_premium"))),
    ]))
    bens = ctx.get("beneficiaries") or []
    story.append(Paragraph("Nominees", ss["H"]))
    if bens:
        for b in bens:
            story.append(Paragraph(f"{_s(b.get('name'))} · {_s(b.get('relationship'))} · {_s(b.get('share_pct'))}%", ss["Body"]))
    else:
        story.append(Paragraph("No nominee recorded.", ss["Body"]))
    story.append(Paragraph("Underwriting terms", ss["H"]))
    story.append(Paragraph(_E(ctx.get("loadings_text") or "Accepted at ordinary (standard) rates."), ss["Body"]))
    return story


def _rules_story(ss, ctx: dict, plan: Optional[InsurancePlan], tenant_name: str) -> list:
    from services import insurer_config as ic
    ins_type = ctx.get("insurance_type") or ""
    story: list = [_section(ss, 8, "How to Register a Claim")]
    contact = [f"Helpline (UAN): {ctx['tenant_phone']}" if ctx.get("tenant_phone") else None,
               f"Email: {ctx['tenant_email']}" if ctx.get("tenant_email") else None,
               f"Web: {ctx['tenant_website']}" if ctx.get("tenant_website") else None]
    contact = [c for c in contact if c]
    story.append(Paragraph(_E(f"Tell {tenant_name} as soon as an event happens that may lead to a claim. You can do this through: "
                              f"{', '.join(ic.CLAIM_CHANNELS)}.") , ss["Body"]))
    if contact:
        story.append(Paragraph(_E(" · ".join(contact)), ss["Body"]))
    steps = [
        "Intimate the claim: quote your policy number and give the date and cause of the event.",
        "Submit the claim form and the documents listed below. Claims are decided only on complete documents.",
        f"We verify the documents and decide the claim, normally within {ic.CLAIM_DECISION_SLA_WORKING_DAYS} working days of complete documents.",
        "Payment is made to the claimant's verified bank account (bank transfer, pay order or mobile wallet).",
    ]
    for n, t in enumerate(steps, 1):
        story.append(Paragraph(f"{n}. {_E(t)}", ss["Body"]))
    applicable = [c["label"] for c in ic.CLAIM_CATEGORIES.values()
                  if ins_type in (c.get("insurance_types") or []) or c["label"] == "Death Claim"]
    story.append(Paragraph("<b>Claims this policy can be used for:</b> " + _E(", ".join(dict.fromkeys(applicable))), ss["Body"]))
    story.append(Paragraph("Documents usually needed (death claim)", ss["H"]))
    for d in ic.CLAIM_DOCUMENTS["Death"]:
        if d["when"] in ("always", "individual") and d["required"]:
            story.append(Paragraph("• " + _E(d["label"]), ss["Body"]))
    story.append(Paragraph("Further documents may be asked for depending on the cause of death and who is claiming.", ss["Fine"]))

    story.append(PageBreak())
    st = (plan.surrender_terms or {}) if plan is not None else {}
    story.append(_section(ss, 9, "Policy Rules"))

    story.append(Paragraph("Maturity", ss["H"]))
    profile = ic.EXIT_PROFILE_BY_TYPE.get(ins_type, "Protection")
    rules = ic.EXIT_DEFAULT_RULES
    if profile == "Savings":
        story.append(Paragraph(_E(
            f"This is a savings-type policy. At the end of the term ({ctx.get('term_years')} years) the maturity benefit is paid; "
            f"we start identifying maturing policies {rules['maturity_window_days']} days ahead and write to you before the maturity date. "
            "The amount depends on the policy terms and the value of your account at maturity, less any amounts owed to us."), ss["Body"]))
    else:
        story.append(Paragraph(_E(
            "This is a protection-type policy. At the end of the term the cover simply ends and the policy closes with no maturity "
            "payment. A death benefit, if one arises while the cover is in force, is settled as a claim."), ss["Body"]))

    story.append(Paragraph("Surrender", ss["H"]))
    if st.get("has_surrender_value"):
        sched = []
        for row in st.get("charge_schedule") or []:
            end = row.get("through")
            span = f"year {row['from']}" if end == row["from"] else (f"year {row['from']} onward" if end is None else f"years {row['from']}-{end}")
            sched.append(f"{span}: {row.get('charge_pct')}% surrender charge")
        story.append(Paragraph(_E("You may surrender the policy early and receive the net surrender value. Surrender charges: "
                                  + ("; ".join(sched) if sched else "as per the product specification") + "."), ss["Body"]))
        extras = []
        if st.get("processing_fee_pkr") is not None:
            extras.append(f"Processing fee: PKR {st['processing_fee_pkr']:,.0f}.")
        pw = st.get("partial_withdrawal") or {}
        if pw:
            extras.append(f"Partial withdrawal after {pw.get('minimum_inforce_months')} months in force, up to "
                          f"{pw.get('maximum_pct_of_net_cash_surrender_value')}% of the net cash value, "
                          f"{pw.get('maximum_per_year')} times a year, keeping at least PKR "
                          f"{(pw.get('minimum_remaining_net_cash_surrender_value_pkr') or 0):,.0f}.")
        loan = st.get("loan") or {}
        if loan:
            extras.append(f"Loan up to {loan.get('maximum_pct_of_net_cash_surrender_value')}% of the net cash value. {loan.get('eligibility_text') or ''}")
        sv = st.get("servicing") or {}
        if sv.get("required_documents"):
            extras.append("To surrender, send: " + ", ".join(sv["required_documents"]) + ".")
        for e in extras:
            story.append(Paragraph(_E(e), ss["Body"]))
        for n in st.get("notes") or []:
            story.append(Paragraph(_E(n), ss["Fine"]))
    elif profile == "Savings":
        story.append(Paragraph(_E(f"Surrender is possible after {rules['surrender_min_years']} completed policy years. The payable share of the "
                                  "fund value rises with the years completed; the exact figure is quoted when you apply."), ss["Body"]))
    else:
        story.append(Paragraph("This protection plan has no surrender value.", ss["Body"]))

    story.append(Paragraph("Return of the policy (free-look)", ss["H"]))
    days = st.get("free_look_days") or 14
    story.append(Paragraph(_E(ic.NOTICE_FREE_LOOK.replace("14 days", f"{days} days")), ss["Body"]))

    story.append(Paragraph("Reinstatement", ss["H"]))
    rr = ic.reinstatement_rules(ctx.get("product_name"))
    story.append(Paragraph(_E(ic.NOTICE_GRACE_LAPSE), ss["Body"]))
    story.append(Paragraph(_E(
        f"A lapsed policy can be revived within {rr['window_days']} days of lapsing by paying the unpaid premiums and signing a "
        f"Declaration of Good Health. If it lapsed {rr['declaration_only_days']} days ago or less, the declaration is normally enough; "
        f"after {rr['medical_evidence_days']} days a medical examination may be required, and revival is always subject to underwriting approval."),
        ss["Body"]))
    return story


async def _collect(arts: List[Artifact], index: List[Tuple[str, str, str]], *, max_pages: int,
                   dedupe: bool, seen: Optional[set] = None, label=None) -> List[bytes]:
    """PDF bytes for these artifacts, in order, each PDF cut to `max_pages` pages. With `dedupe` a file already included
    is skipped; without it every artifact gets its own pages (each test's report is included even if the same file was
    uploaded for several tests). A file is only downloaded once either way."""
    seen = seen if seen is not None else set()
    # Storage reads can be slow: fetch each distinct file once, all together, off the event loop.
    keys = {}
    for a in arts:
        keys.setdefault((a.file_name, a.file_size), a)
    fetched = dict(zip(keys, await asyncio.gather(*(asyncio.to_thread(_fetch, a) for a in keys.values()))))

    out: List[bytes] = []
    for pos, a in enumerate(arts, 1):
        name = a.file_name or "file"
        caption = label(a, pos, len(arts)) if label else f"{a.document_type} - {name}"
        ext = name.lower().rsplit(".", 1)[-1] if "." in name else ""
        data = fetched.get((a.file_name, a.file_size))
        if data is None:
            index.append((name, caption, "(not included: file could not be read)"))
            continue
        digest = hashlib.sha256(data).hexdigest()
        if dedupe and digest in seen:
            index.append((name, caption, "(same file already included)"))
            continue
        seen.add(digest)
        try:
            note = ""
            if ext == "pdf" or data[:4] == b"%PDF":
                reader = PdfReader(io.BytesIO(data))
                w = PdfWriter()
                for page in reader.pages[:max_pages]:
                    _stamp(page, caption)
                    w.add_page(page)
                if len(reader.pages) > max_pages:
                    note = f"(first {max_pages} of {len(reader.pages)} pages)"
                buf = io.BytesIO()
                w.write(buf)
                out.append(buf.getvalue())
            else:
                out.append(_image_pdf(data, caption))
            index.append((name, caption, note))
        except Exception:
            log.warning("dossier: could not include %s", name, exc_info=True)
            index.append((name, caption, "(not included: unsupported or damaged file)"))
    return out


def _latest_per_type(arts: List[Artifact]) -> List[Artifact]:
    """The newest usable upload for each document type (one that was not sent back for re-upload)."""
    latest: dict = {}
    for a in arts:
        if a.status == "Re-submission Requested":
            continue
        latest[a.document_type] = a
    return list(latest.values())


async def build(session: AsyncSession, policy: Policy) -> Optional[str]:
    """Build the dossier PDF for a policy and return its path (None if the customer is missing)."""
    from services.policy_documents import build_document_context
    from services import document_requests as docreq

    customer = await session.get(Customer, policy.customer_id)
    if customer is None:
        return None
    tenant = await session.get(Tenant, policy.tenant_id)
    tenant_name = tenant.name if tenant else "Insurer"
    ctx = await build_document_context(session, policy)
    cases = (await session.exec(select(Case).where(Case.policy_id == policy.id))).all()
    case_ids = [c.caseld for c in cases]
    eapp = med = None
    if case_ids:
        eapp = (await session.exec(select(CustomerEApplication).where(CustomerEApplication.case_id.in_(case_ids)))).first()
        med = (await session.exec(select(MedicalExamOrder).where(MedicalExamOrder.case_id.in_(case_ids)))).first()
    plan = (await session.exec(select(InsurancePlan).where(
        InsurancePlan.tenant_id == policy.tenant_id, InsurancePlan.label == policy.product_name))).first()

    arts = (await session.exec(
        select(Artifact).where(Artifact.tenant_id == policy.tenant_id, Artifact.customer_id == policy.customer_id,
                               Artifact.claim_id.is_(None)).order_by(Artifact.created_at)
    )).all()
    medical = _latest_per_type([a for a in arts if (a.document_type or "").startswith("Medical Report")])
    required = set(await docreq.required_documents_for(session, policy))
    personal = _latest_per_type([a for a in arts if a.document_type in required])

    index: List[Tuple[str, str, str]] = []
    # Every medical report is included, one per test; the personal documents skip repeats.
    test_names = {t.get("code"): t.get("name") for t in ((med.required_tests if med else None) or [])}

    def medical_label(a: Artifact, pos: int, total: int) -> str:
        code = a.document_type.split(": ", 1)[-1]
        return f"Medical report {pos} of {total}: {test_names.get(code) or code} ({code})"

    medical_pdfs = await _collect(sorted(medical, key=lambda a: a.document_type), index, max_pages=1, dedupe=False,
                                  label=medical_label)
    personal_pdfs = await _collect(personal, index, max_pages=MAX_PAGES_PER_FILE, dedupe=True)

    ss = _styles()
    meta = {"tenant_name": tenant_name, "customer_name": customer.name or "the policyholder",
            "policy_number": policy.policy_number or "Draft",
            "contact": " · ".join(x for x in (ctx.get("tenant_phone"), ctx.get("tenant_email"), ctx.get("tenant_website")) if x)}
    out_dir = os.path.join(dg.MEDIA_ROOT, str(policy.id))
    os.makedirs(out_dir, exist_ok=True)
    front = os.path.join(out_dir, "dossier_front.pdf")
    back = os.path.join(out_dir, "dossier_back.pdf")
    story = (_cover_story(ss, customer, policy, tenant_name, ctx)
             + _info_story(ss, customer, policy, tenant_name, eapp, med) + _proposal_story(ss, ctx)
             + _details_story(ss, customer))
    story.append(_section(ss, 7, "Attached Scans and Policy Wording"))
    if plan is not None and plan.policy_wording_path and os.path.isfile(plan.policy_wording_path):
        index.append((plan.policy_wording_filename or "policy wording", f"Policy wording: {plan.label}", ""))
    if index:
        head = [Paragraph(h, ss["CellLabel"]) for h in ("No.", "Document", "File")]
        data = [head] + [[Paragraph(str(n), ss["Cell"]), Paragraph(f"<b>{_E(kind)}</b>", ss["Cell"]),
                          Paragraph(f"{_E(name)} {_E(note)}".strip(), ss["Cell"])] for n, (name, kind, note) in enumerate(index, 1)]
        tbl = Table(data, colWidths=[12 * mm, 80 * mm, _CONTENT_W - 92 * mm], repeatRows=1)
        tbl.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), _LABEL_BG), ("BOX", (0, 0), (-1, -1), 0.6, _RULE),
            ("LINEBELOW", (0, 0), (-1, -2), 0.4, _RULE), ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, _ZEBRA]),
            ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(tbl)
    else:
        story.append(Paragraph("No scans on file.", ss["Body"]))
    _build_doc(front, story, meta)
    _build_doc(back, _rules_story(ss, ctx, plan, tenant_name), meta)

    writer = PdfWriter()
    wording = []
    if plan is not None and plan.policy_wording_path and os.path.isfile(plan.policy_wording_path):
        try:
            wr = PdfReader(plan.policy_wording_path)
            for page in wr.pages:
                _stamp(page, f"Policy wording: {plan.label}")
            buf = io.BytesIO()
            ww = PdfWriter()
            for page in wr.pages:
                ww.add_page(page)
            ww.write(buf)
            wording.append(buf.getvalue())
        except Exception:
            log.warning("dossier: could not include the policy wording for %s", plan.label, exc_info=True)
    for path_or_blob in [front, *medical_pdfs, *personal_pdfs, *wording, back]:
        reader = PdfReader(path_or_blob if isinstance(path_or_blob, str) else io.BytesIO(path_or_blob))
        for page in reader.pages:
            writer.add_page(page)
    _number_pages(writer)
    final = os.path.join(out_dir, "application_dossier.pdf")
    with open(final, "wb") as f:
        writer.write(f)
    os.remove(front)
    os.remove(back)
    return final


async def generate_and_store(session: AsyncSession, policy: Policy, version_id=None) -> Optional[PolicyDocument]:
    """(Re)write the dossier's PolicyDocument row. Best-effort: never stops the other documents."""
    try:
        path = await build(session, policy)
    except Exception:
        log.exception("could not build the application dossier for policy %s", policy.id)
        return None
    if path is None:
        return None
    for old in (await session.exec(select(PolicyDocument).where(
            PolicyDocument.policy_id == policy.id,
            PolicyDocument.document_type == PolicyDocumentTypeEnum.APPLICATION_DOSSIER))).all():
        await session.delete(old)
    doc = PolicyDocument(
        policy_id=policy.id, policy_version_id=version_id,
        document_type=PolicyDocumentTypeEnum.APPLICATION_DOSSIER,
        document_name=f"{DOCUMENT_TITLE} – {policy.policy_number or 'Draft'}",
        storage_url=path, stub_content=None, is_stub=False,
    )
    session.add(doc)
    return doc
