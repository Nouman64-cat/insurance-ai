"""
Real policy-document PDF generation (replaces the Phase-1 text stubs).

Produces the three legal documents an insurer issues at binding:

  • Policy Schedule       — the declarations page (parties, cover, premium).
  • Certificate of Insurance — the proof-of-cover certificate.
  • Policy Wording        — terms, conditions, exclusions and endorsements.

Files are written under MEDIA_ROOT (a path inside the mounted /app volume, so
they persist on the host) and served back through the /documents/{id}/download
endpoint. PolicyDocument.storage_url holds the file path and is_stub becomes
False once a real PDF exists.
"""

from __future__ import annotations

import os
from datetime import date, datetime
from typing import Optional
from uuid import UUID

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    HRFlowable,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from shared.models.core import PolicyDocumentTypeEnum

MEDIA_ROOT = os.getenv("POLICY_DOC_MEDIA_ROOT", "/app/media/policy_documents")

_BRAND = colors.HexColor("#2563eb")   # blue-600, matches the app accent
_INK = colors.HexColor("#0f172a")
_MUTE = colors.HexColor("#64748b")


def _pkr(n: Optional[float]) -> str:
    return f"PKR {n:,.0f}" if n is not None else "—"


def _styles():
    ss = getSampleStyleSheet()
    ss.add(ParagraphStyle("DocTitle", parent=ss["Title"], textColor=_BRAND, fontSize=20, spaceAfter=2))
    ss.add(ParagraphStyle("DocSub", parent=ss["Normal"], textColor=_MUTE, fontSize=9, spaceAfter=10))
    ss.add(ParagraphStyle("H", parent=ss["Heading2"], textColor=_INK, fontSize=12, spaceBefore=10, spaceAfter=4))
    ss.add(ParagraphStyle("Body", parent=ss["Normal"], textColor=_INK, fontSize=9.5, leading=14))
    ss.add(ParagraphStyle("Fine", parent=ss["Normal"], textColor=_MUTE, fontSize=8, leading=11))
    return ss


def _kv_table(rows: list[tuple[str, str]]) -> Table:
    data = [[Paragraph(f"<b>{k}</b>", _styles()["Body"]), Paragraph(v, _styles()["Body"])] for k, v in rows]
    t = Table(data, colWidths=[55 * mm, 110 * mm])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return t


def _card_table(rows: list[tuple[str, str]], title: str = "") -> Table:
    """A visually enclosed card table with a soft background and rounded-like appearance."""
    ss = _styles()
    data = []
    if title:
        data.append([Paragraph(f"<b>{title}</b>", ParagraphStyle("CardTitle", parent=ss["H"], spaceBefore=0, textColor=_BRAND)), ""])
    for k, v in rows:
        data.append([Paragraph(f"<b>{k}</b>", ss["Body"]), Paragraph(v, ss["Body"])])
    
    t = Table(data, colWidths=[50 * mm, 105 * mm])
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc")), # slate-50
        ("BOX", (0, 0), (-1, -1), 1, colors.HexColor("#cbd5e1")),     # slate-300
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
    ]
    if title:
        style.append(("SPAN", (0, 0), (1, 0)))
        style.append(("BOTTOMPADDING", (0, 0), (1, 0), 12))
        
    t.setStyle(TableStyle(style))
    return t


def _header(ss, tenant_name: str, title: str, subtitle: str) -> list:
    return [
        Paragraph(tenant_name, ParagraphStyle("brand", parent=ss["DocSub"], textColor=_BRAND, fontSize=11)),
        Paragraph(title, ss["DocTitle"]),
        Paragraph(subtitle, ss["DocSub"]),
        HRFlowable(width="100%", thickness=1.2, color=_BRAND, spaceAfter=8),
    ]


def _footer(ss) -> list:
    return [
        Spacer(1, 14),
        HRFlowable(width="100%", thickness=0.4, color=colors.HexColor("#e2e8f0"), spaceAfter=4),
        Paragraph(
            f"Generated {datetime.utcnow().strftime('%d %b %Y %H:%M UTC')}. This is a system-generated "
            "document. For queries contact your servicing branch.", ss["Fine"]),
    ]


def _build(path: str, story: list) -> None:
    doc = SimpleDocTemplate(path, pagesize=A4,
                            leftMargin=22 * mm, rightMargin=22 * mm,
                            topMargin=20 * mm, bottomMargin=18 * mm)
    doc.build(story)


def generate_premium_notice(ctx: dict) -> dict:
    """
    Render a fully-enriched Premium Notice (pre-payment bill).

    Sections:
      A. Insurer letterhead + document meta (challan ref, issue date, pay-by)
      B. Policyholder block (name, CNIC, DOB/age, city/province)
      C. Contract summary (product, sum assured, term, frequency, advisor)
      D. Underwriting terms line
      E. Amount-due table + billing period + bold total
      F. How to Pay — payment channels with challan reference
      G. Legal notices (SECP-expected)
      H. Authorised signatory + system-generated footer
    """
    from services.insurer_config import (
        PAYMENT_CHANNELS,
        NOTICE_ACTIVATION_CLAUSE,
        NOTICE_FREE_LOOK,
        NOTICE_GRACE_LAPSE,
        NOTICE_NTU,
        NOTICE_FRAUD,
        NOTICE_GRIEVANCE,
    )

    ss = _styles()
    pid = ctx["policy_id"]
    policy_number = ctx.get("policy_number") or "DRAFT"
    out_dir = os.path.join(MEDIA_ROOT, str(pid))
    os.makedirs(out_dir, exist_ok=True)
    notice_path = os.path.join(out_dir, "premium_notice.pdf")

    tenant_name = ctx.get("tenant_name", "Insurer")
    pb = ctx.get("premium_breakdown") or {}
    customer_name = ctx.get("customer_name") or "—"
    issue_date = ctx.get("issue_date", datetime.utcnow().strftime("%Y-%m-%d"))
    due_date = ctx.get("due_date", "—")
    challan_ref = ctx.get("challan_ref", f"CHALLAN-{policy_number}")

    story: list = []

    # ── A. Letterhead & Document Meta ─────────────────────────────────────────
    addr_parts = [ctx.get("tenant_address"), ctx.get("tenant_city"), ctx.get("tenant_province")]
    tenant_addr = ", ".join(p for p in addr_parts if p) or "—"

    contact_parts = []
    if ctx.get("tenant_phone"):
        contact_parts.append(f"UAN: {ctx['tenant_phone']}")
    if ctx.get("tenant_email"):
        contact_parts.append(f"Email: {ctx['tenant_email']}")
    if ctx.get("tenant_website"):
        contact_parts.append(f"Web: {ctx['tenant_website']}")

    reg_parts = []
    if ctx.get("tenant_reg_no"):
        reg_parts.append(f"SECP Reg: {ctx['tenant_reg_no']}")
    if ctx.get("tenant_license_no"):
        reg_parts.append(f"License: {ctx['tenant_license_no']}")

    story.append(Paragraph(tenant_name.upper(), ParagraphStyle(
        "Letterhead", parent=ss["DocSub"], textColor=_BRAND, fontSize=14, fontName="Helvetica-Bold")))
    story.append(Paragraph(tenant_addr, ss["Fine"]))
    if contact_parts:
        story.append(Paragraph("  ·  ".join(contact_parts), ss["Fine"]))
    if reg_parts:
        story.append(Paragraph("  ·  ".join(reg_parts), ss["Fine"]))
    story.append(Spacer(1, 6))
    story.append(HRFlowable(width="100%", thickness=1.6, color=_BRAND, spaceAfter=4))

    story.append(Paragraph("FIRST PREMIUM NOTICE", ParagraphStyle(
        "NoticeTitle", parent=ss["DocTitle"], textColor=_BRAND, fontSize=18, spaceAfter=2)))
    story.append(_kv_table([
        ("Challan / Notice No.", challan_ref),
        ("Issue Date", str(issue_date)),
        ("Pay By (Due Date)", f"<b>{due_date}</b>"),
        ("Policy Reference", policy_number),
    ]))
    story.append(Spacer(1, 8))

    # ── B. Policyholder Block ─────────────────────────────────────────────────
    story.append(Paragraph("Policyholder Details", ss["H"]))
    ph_rows: list[tuple] = [("Name", f"<b>{customer_name}</b>")]
    if ctx.get("customer_cnic"):
        ph_rows.append(("CNIC / ID", ctx["customer_cnic"]))
    if ctx.get("customer_dob"):
        age_str = f"  (Age: {ctx['customer_age']})" if ctx.get("customer_age") else ""
        ph_rows.append(("Date of Birth", f"{ctx['customer_dob']}{age_str}"))
    loc_parts = [ctx.get("customer_city"), ctx.get("customer_province")]
    location = ", ".join(p for p in loc_parts if p)
    if location:
        ph_rows.append(("City / Province", location))
    story.append(_kv_table(ph_rows))
    story.append(Spacer(1, 4))

    # ── C. Contract Summary ───────────────────────────────────────────────────
    story.append(Paragraph("Contract Summary", ss["H"]))
    contract_rows: list[tuple] = [
        ("Product", ctx.get("product_name") or "—"),
        ("Plan Type", ctx.get("insurance_type") or "—"),
        ("Sum Assured", _pkr(ctx.get("coverage_amount"))),
        ("Policy Term", f"{ctx.get('term_years', '—')} years"),
        ("Premium Frequency", ctx.get("billing_frequency") or "Annual"),
        ("Commencement Date", str(ctx.get("effective_date") or "—")),
        ("Expiry Date", str(ctx.get("expiry_date") or "—")),
    ]
    if ctx.get("agent_name"):
        contract_rows.append(("Advisor / Agent", ctx["agent_name"]))
    story.append(_kv_table(contract_rows))
    story.append(Spacer(1, 4))

    # ── D. Underwriting Terms ─────────────────────────────────────────────────
    story.append(Paragraph("Underwriting Terms", ss["H"]))
    loadings_text = ctx.get("loadings_text") or "Accepted at ordinary (standard) rates."
    excl = ctx.get("exclusions") or []
    if excl:
        loadings_text += f" Special exclusions: {'; '.join(excl)}."
    story.append(Paragraph(loadings_text, ss["Body"]))
    story.append(Spacer(1, 4))

    # ── E. Amount Due ─────────────────────────────────────────────────────────
    story.append(Paragraph("Amount Due", ss["H"]))
    story.append(_kv_table([
        ("Base Premium", _pkr(pb.get("base_premium"))),
        ("Underwriting Loading", _pkr(pb.get("loading_amount"))),
        ("Policy Fee", _pkr(pb.get("policy_fee"))),
        ("Stamp Duty", _pkr(pb.get("stamp_duty_amount"))),
        ("Sales Tax", _pkr(pb.get("tax_amount"))),
    ]))
    story.append(Spacer(1, 2))
    story.append(Paragraph(
        f"<b>Total First Premium Due:  {_pkr(pb.get('total_premium'))}</b>",
        ParagraphStyle("Total", parent=ss["Body"], fontSize=11, textColor=_BRAND)))
    story.append(Paragraph(
        f"Billing Period: {ctx.get('effective_date') or '—'} to {ctx.get('expiry_date') or '—'}"
        f"  ·  Due Date: <b>{due_date}</b>",
        ss["Fine"]))
    story.append(Spacer(1, 8))

    # ── F. How to Pay ─────────────────────────────────────────────────────────
    story.append(Paragraph("How to Pay", ss["H"]))
    story.append(Paragraph(
        f"Please quote Challan No. <b>{challan_ref}</b> with every payment to ensure correct allocation.",
        ss["Body"]))
    story.append(Spacer(1, 4))
    for ch in PAYMENT_CHANNELS:
        story.append(Paragraph(f"<b>{ch['label']}</b>", ss["Body"]))
        story.append(Paragraph(ch["detail"], ss["Body"]))
        if ch.get("note"):
            story.append(Paragraph(ch["note"], ss["Fine"]))
        story.append(Spacer(1, 4))

    # ── G. Legal Notices ──────────────────────────────────────────────────────
    story.append(HRFlowable(width="100%", thickness=0.4,
                             color=colors.HexColor("#e2e8f0"), spaceBefore=4, spaceAfter=4))
    story.append(Paragraph("Important Notices", ss["H"]))
    for notice in [
        NOTICE_ACTIVATION_CLAUSE, NOTICE_FREE_LOOK, NOTICE_GRACE_LAPSE,
        NOTICE_NTU, NOTICE_FRAUD, NOTICE_GRIEVANCE,
    ]:
        story.append(Paragraph(f"• {notice}", ss["Fine"]))
        story.append(Spacer(1, 3))

    # ── H. Signatory ─────────────────────────────────────────────────────────
    story.append(Spacer(1, 14))
    story.append(_kv_table([
        ("Authorised Signatory", tenant_name),
        ("Designation", "Head of New Business"),
    ]))
    story += _footer(ss)

    _build(notice_path, story)

    return {
        "document_type": PolicyDocumentTypeEnum.PREMIUM_NOTICE.value,
        "document_name": f"Premium Notice \u2013 {policy_number}",
        "file_path": notice_path,
    }



def generate_policy_documents(ctx: dict) -> list[dict]:
    """
    Render all three PDFs for a policy. ``ctx`` carries the flattened data the
    router assembles from Policy / Customer / PolicyVersion / Beneficiary.
    Returns metadata dicts: {document_type, document_name, file_path}.
    """
    ss = _styles()
    pid = ctx["policy_id"]
    policy_number = ctx.get("policy_number") or "DRAFT"
    out_dir = os.path.join(MEDIA_ROOT, str(pid))
    os.makedirs(out_dir, exist_ok=True)

    tenant = ctx.get("tenant_name", "Insurer")
    beneficiaries = ctx.get("beneficiaries") or []
    pb = ctx.get("premium_breakdown") or {}
    results: list[dict] = []

    # ── 1. Policy Schedule ────────────────────────────────────────────────────
    sched = os.path.join(out_dir, "policy_schedule.pdf")
    story = _header(ss, tenant, "Policy Schedule", f"Policy No. {policy_number}")
    story.append(Paragraph("Insured & Contract", ss["H"]))
    story.append(_kv_table([
        ("Policyholder", ctx.get("customer_name", "—")),
        ("CNIC", ctx.get("customer_cnic") or "—"),
        ("Product", ctx.get("product_name", "—")),
        ("Plan Type", ctx.get("insurance_type", "—")),
        ("Sum Assured", _pkr(ctx.get("coverage_amount"))),
        ("Policy Term", f"{ctx.get('term_years', '—')} years"),
        ("Start Date", str(ctx.get("effective_date") or "—")),
        ("Expiry", str(ctx.get("expiry_date") or "—")),
    ]))
    story.append(Paragraph("Premium", ss["H"]))
    story.append(_kv_table([
        ("Base Premium", _pkr(pb.get("base_premium"))),
        ("Underwriting Loading", _pkr(pb.get("loading_amount"))),
        ("Policy Fee", _pkr(pb.get("policy_fee"))),
        ("Stamp Duty", _pkr(pb.get("stamp_duty_amount"))),
        ("Sales Tax", _pkr(pb.get("tax_amount"))),
        ("Total Annual Premium", _pkr(pb.get("total_premium"))),
    ]))
    if beneficiaries:
        story.append(Paragraph("Beneficiaries", ss["H"]))
        story.append(_kv_table([
            (b["name"], f"{b['relationship']} · {b['share_pct']:.0f}%") for b in beneficiaries
        ]))
    story += _footer(ss)
    _build(sched, story)
    results.append({"document_type": PolicyDocumentTypeEnum.SCHEDULE.value,
                    "document_name": f"Policy Schedule – {policy_number}", "file_path": sched})

    # ── 2. Certificate of Insurance ───────────────────────────────────────────
    cert = os.path.join(out_dir, "certificate.pdf")
    story = _header(ss, tenant, "Certificate of Insurance", f"Policy No. {policy_number}")
    story.append(Paragraph(
        f"This certifies that <b>{ctx.get('customer_name','—')}</b> (CNIC "
        f"{ctx.get('customer_cnic') or '—'}) is insured under policy "
        f"<b>{policy_number}</b> — {ctx.get('product_name','—')} — for a sum assured of "
        f"<b>{_pkr(ctx.get('coverage_amount'))}</b>, effective "
        f"<b>{ctx.get('effective_date') or '—'}</b> to <b>{ctx.get('expiry_date') or '—'}</b>, "
        "subject to the terms, conditions and exclusions of the policy wording.", ss["Body"]))
    story.append(Spacer(1, 10))
    story.append(_kv_table([
        ("Issued By", tenant),
        ("Total Annual Premium", _pkr(pb.get("total_premium"))),
        ("Beneficiaries", ", ".join(f"{b['name']} ({b['share_pct']:.0f}%)" for b in beneficiaries) or "As per schedule"),
    ]))
    story += _footer(ss)
    _build(cert, story)
    results.append({"document_type": PolicyDocumentTypeEnum.CERTIFICATE.value,
                    "document_name": f"Certificate of Insurance – {policy_number}", "file_path": cert})

    # ── 3. Policy Wording / Terms & Conditions ────────────────────────────────
    wording = os.path.join(out_dir, "policy_wording.pdf")
    story = _header(ss, tenant, "Policy Wording", f"{ctx.get('product_name','—')} — {policy_number}")
    clauses = [
        ("1. Cover", f"The insurer agrees, subject to the terms herein, to pay the sum assured of "
                     f"{_pkr(ctx.get('coverage_amount'))} on a valid claim during the policy term."),
        ("2. Premium", "Cover is conditional on payment of the first premium and subsequent premiums "
                       "when due. Non-payment beyond the grace period lapses the policy."),
        ("3. Free-look Period", "The policyholder may cancel within 14 days of receipt for a refund of "
                                "premium less expenses incurred."),
        ("4. Beneficiaries", "The benefit is payable to the nominated beneficiaries in the shares recorded "
                             "in the schedule."),
        ("5. Exclusions", "Standard exclusions apply (e.g. suicide within the first policy year, "
                          "material misrepresentation)."),
    ]
    excl = ctx.get("exclusions") or []
    if excl:
        clauses.append(("6. Special Exclusions (Underwriting)",
                        "The following additional exclusions apply to this policy: " + "; ".join(excl) + "."))
    for h, body in clauses:
        story.append(Paragraph(h, ss["H"]))
        story.append(Paragraph(body, ss["Body"]))
    story += _footer(ss)
    _build(wording, story)
    results.append({"document_type": PolicyDocumentTypeEnum.WORDING.value,
                    "document_name": f"Policy Wording & Endorsements – {ctx.get('product_name','—')}",
                    "file_path": wording})

    return results


def generate_welcome_kit(ctx: dict) -> dict:
    """Render the Stage B welcome kit — a customer-facing welcome letter/pack."""
    ss = _styles()
    pid = ctx["policy_id"]
    tenant_name = ctx.get("tenant_name", "Insurer")
    customer_name = ctx.get("customer_name") or "Valued Policyholder"
    out_dir = os.path.join(MEDIA_ROOT, str(pid))
    os.makedirs(out_dir, exist_ok=True)
    kit_path = os.path.join(out_dir, "welcome_kit.pdf")

    story: list = []
    
    city = ctx.get("customer_city")
    
    # Tenant and Region placed above the banner
    story.append(Paragraph(tenant_name.upper(), ParagraphStyle("KitTenant", parent=ss["Body"], textColor=_BRAND, fontSize=14, fontName="Helvetica-Bold")))
    if city:
        story.append(Paragraph(f"Region: {city}", ParagraphStyle("KitRegion", parent=ss["Body"], textColor=_MUTE, fontSize=11, fontName="Helvetica", spaceBefore=2)))
    story.append(Spacer(1, 15))
    
    # Professional Hero Banner (Now only for Customer Name and Title)
    banner_data = [[
        Paragraph(customer_name, ParagraphStyle("BannerName", parent=ss["Body"], textColor=colors.white, fontSize=22, fontName="Helvetica-Bold", leading=24, spaceBefore=0, spaceAfter=0)),
        Paragraph("WELCOME KIT", ParagraphStyle("BannerTitle", parent=ss["DocTitle"], textColor=colors.white, alignment=2, leading=24, spaceBefore=0, spaceAfter=0))
    ]]
    banner = Table(banner_data, colWidths=[80*mm, 85*mm])
    banner.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), _BRAND),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 20),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 20),
        ("LEFTPADDING", (0, 0), (-1, -1), 15),
        ("RIGHTPADDING", (0, 0), (-1, -1), 15),
    ]))
    story.append(banner)
    story.append(Spacer(1, 20))

    story.append(Paragraph(f"Dear {customer_name},", ParagraphStyle("Greeting", parent=ss["H"], spaceBefore=0)))
    story.append(Paragraph(
        f"Thank you for choosing <b>{tenant_name}</b>. Your policy is now active and your family's protection "
        "has begun. This welcome kit summarises your cover, your policyholder ID, and instructions for managing "
        "your policy online via our customer portal.", ss["Body"]))
    story.append(Spacer(1, 15))

    story.append(_card_table([
        ("Policyholder ID", f"<b>{ctx.get('policyholder_id') or '—'}</b>"),
        ("Policy Number", ctx.get("policy_number") or "—"),
    ], title="Policyholder Identity"))
    story.append(Spacer(1, 5))
    story.append(Paragraph("Quote your Policyholder ID whenever you contact us — it links every policy you hold with us.", ss["Fine"]))
    story.append(Spacer(1, 15))

    cov = ctx.get("coverage_amount")
    cov_str = "—"
    if cov is not None:
        if cov >= 1_000_000: cov_str = f"PKR {cov/1_000_000:g} Million"
        elif 0 < cov < 1000: cov_str = f"PKR {cov:g} Million"
        else: cov_str = f"PKR {cov:,.0f}"

    story.append(_card_table([
        ("Product", ctx.get("product_name") or "—"),
        ("Sum Assured", cov_str),
        ("Insurance Term", f"{ctx.get('term_years', '—')} years"),
        ("Effective From", str(ctx.get("effective_date") or "—")),
        ("Expiry Date", str(ctx.get("expiry_date") or "—")),
    ], title="Cover at a Glance"))
    story.append(Spacer(1, 15))

    fl_end = ctx.get("free_look_end_date")
    fl_line = (f"If this policy does not meet your needs you may cancel it on or before "
               f"<b>{fl_end}</b> for a full refund of premium (subject to regulations)."
               if fl_end else
               "You may cancel within 14 days of receiving this policy for a full refund of premium.")
    
    story.append(_card_table([
        ("Portal Link", ctx.get("portal_url") or "—"),
        ("Username", ctx.get("portal_username") or "—"),
        ("Password", "Sent separately — you will be prompted to set this on first login."),
    ], title="Manage Policy Online"))
    story.append(Spacer(1, 5))
    story.append(Paragraph("Through the portal you can view documents, pay premiums, update details and lodge claims.", ss["Fine"]))
    story.append(Spacer(1, 15))

    story.append(Paragraph("14-Day Free-Look Right", ss["H"]))
    story.append(Paragraph(fl_line, ss["Body"]))
    story.append(Spacer(1, 15))

    story.append(Paragraph("Need Help?", ss["H"]))
    help_bits = []
    if ctx.get("tenant_phone"): help_bits.append(f"UAN: {ctx['tenant_phone']}")
    if ctx.get("tenant_email"): help_bits.append(f"Email: {ctx['tenant_email']}")
    story.append(Paragraph("  ·  ".join(help_bits) if help_bits else "Contact your servicing branch for assistance.", ss["Body"]))

    story += _footer(ss)
    _build(kit_path, story)
    return {"document_name": f"Welcome Kit – {ctx.get('product_name', 'Policy')}", "file_path": kit_path}


def generate_receipt(ctx: dict) -> dict:
    """Render a premium payment receipt PDF. Returns {document_name, file_path}."""
    ss = _styles()
    pid = ctx["policy_id"]
    tenant_name = ctx.get("tenant_name", "Insurer")
    out_dir = os.path.join(MEDIA_ROOT, str(pid))
    os.makedirs(out_dir, exist_ok=True)
    receipt_no = ctx.get("receipt_no", "RCPT")
    path = os.path.join(out_dir, f"receipt_{receipt_no}.pdf")

    story: list = []
    story += _header(ss, tenant_name, "Premium Payment Receipt",
                     f"Receipt No. {receipt_no}")
    story.append(_kv_table([
        ("Policyholder", ctx.get("customer_name") or "—"),
        ("Policy Number", ctx.get("policy_number") or "—"),
        ("Installment", f"#{ctx.get('installment_no', '—')}"),
        ("Payment Date", str(ctx.get("paid_date") or "—")),
        ("Method", ctx.get("method") or "—"),
        ("Reference", ctx.get("payment_reference") or "—"),
    ]))
    story.append(Spacer(1, 8))
    story.append(Paragraph("Amount", ss["H"]))
    rows = [("Base Premium", _pkr(ctx.get("base_amount")))]
    if ctx.get("surcharge_amount"):
        rows.append(("Late-Payment Surcharge", _pkr(ctx.get("surcharge_amount"))))
    rows.append(("Total Paid", f"<b>{_pkr(ctx.get('total_amount'))}</b>"))
    story.append(_kv_table(rows))
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        "This is a computer-generated receipt acknowledging payment received. "
        "It confirms the premium above has been credited to the policy.", ss["Fine"]))
    story += _footer(ss)
    _build(path, story)
    return {"document_name": f"Receipt {receipt_no}", "file_path": path}


def generate_lapse_warning(ctx: dict) -> dict:
    """Render a formal lapse-warning letter PDF. Returns {document_name, file_path}."""
    ss = _styles()
    pid = ctx["policy_id"]
    tenant_name = ctx.get("tenant_name", "Insurer")
    out_dir = os.path.join(MEDIA_ROOT, str(pid))
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "lapse_warning.pdf")

    story: list = []
    story += _header(ss, tenant_name, "Notice of Impending Lapse",
                     f"Policy {ctx.get('policy_number', '—')}")
    story.append(Paragraph(f"Dear {ctx.get('customer_name') or 'Policyholder'},", ss["Body"]))
    story.append(Paragraph(
        f"Our records show an outstanding premium of <b>{_pkr(ctx.get('amount_due'))}</b> on your "
        f"policy. The grace period ends on <b>{ctx.get('grace_until', '—')}</b>. If payment is not "
        "received by that date, your policy will <b>lapse</b> and all cover and benefits will cease.",
        ss["Body"]))
    story.append(Paragraph(
        "To keep your policy in force, please pay the outstanding amount before the grace period "
        "ends. After lapse, revival will require reinstatement and may be subject to fresh "
        "underwriting.", ss["Body"]))
    story.append(Spacer(1, 6))
    story.append(Paragraph("Please treat this as a matter of urgency.", ss["Body"]))
    story += _footer(ss)
    _build(path, story)
    return {"document_name": "Lapse Warning Letter", "file_path": path}


def generate_endorsement_letter(ctx: dict) -> dict:
    """Render an endorsement letter PDF (what changed, effective date, premium
    impact). Returns {document_name, file_path}."""
    ss = _styles()
    pid = ctx["policy_id"]
    tenant_name = ctx.get("tenant_name", "Insurer")
    eno = ctx.get("endorsement_no", "E1")
    out_dir = os.path.join(MEDIA_ROOT, str(pid))
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"endorsement_{eno}.pdf")

    delta = ctx.get("premium_delta") or 0.0
    delta_line = ("No change to premium." if abs(delta) < 0.005
                  else f"Premium {'increased' if delta > 0 else 'decreased'} by {_pkr(abs(delta))} per year.")

    story: list = []
    story += _header(ss, tenant_name, "Policy Endorsement",
                     f"Endorsement {eno} · {ctx.get('endorsement_type', '')}")
    story.append(Paragraph(f"Dear {ctx.get('customer_name') or 'Policyholder'},", ss["Body"]))
    story.append(Paragraph(
        "This endorsement records the following approved change to your policy. It forms part of your "
        "policy contract and should be kept with your documents.", ss["Body"]))
    story.append(Spacer(1, 6))
    story.append(_kv_table([
        ("Policy Number", ctx.get("policy_number") or "—"),
        ("Endorsement No.", eno),
        ("Type", ctx.get("endorsement_type", "—")),
        ("Effective Date", str(ctx.get("effective_date") or "—")),
    ]))
    story.append(Spacer(1, 8))
    story.append(Paragraph("Change", ss["H"]))
    story.append(Paragraph(ctx.get("summary", "—"), ss["Body"]))
    story.append(Paragraph(delta_line, ss["Body"]))
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "All other terms and conditions of the policy remain unchanged. If any detail above is incorrect, "
        "please contact your servicing branch promptly.", ss["Fine"]))
    story += _footer(ss)
    _build(path, story)
    return {"document_name": f"Endorsement {eno}", "file_path": path}


def generate_reinstatement_confirmation(ctx: dict) -> dict:
    """Render the reinstatement confirmation PDF: effective date, what was paid,
    any revised terms, and the statement that no cover existed during the lapse.
    Returns {document_name, file_path}."""
    ss = _styles()
    pid = ctx["policy_id"]
    tenant_name = ctx.get("tenant_name", "Insurer")
    case_no = ctx.get("case_no", "RN")
    out_dir = os.path.join(MEDIA_ROOT, str(pid))
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"reinstatement_{case_no}.pdf")

    terms = ctx.get("terms") or {}
    story: list = []
    story += _header(ss, tenant_name, "Policy Reinstatement Confirmation",
                     f"Policy {ctx.get('policy_number', '—')} · Case {case_no}")
    story.append(Paragraph(f"Dear {ctx.get('customer_name') or 'Policyholder'},", ss["Body"]))
    story.append(Paragraph(
        "We are pleased to confirm that your lapsed policy has been <b>reinstated</b>. Your original "
        "policy number and history are unchanged.", ss["Body"]))
    story.append(Spacer(1, 6))
    story.append(_card_table([
        ("Policy Number", ctx.get("policy_number") or "—"),
        ("Product", ctx.get("product_name") or "—"),
        ("Sum Assured", _pkr(ctx.get("sum_assured"))),
        ("Lapsed On", str(ctx.get("lapse_date") or "—")),
        ("Reinstated (Effective)", str(ctx.get("effective_date") or "—")),
        ("Policy Version", str(ctx.get("version_number") or "—")),
    ], title="Reinstatement Details"))

    story.append(Spacer(1, 8))
    story.append(Paragraph("Amount received", ss["H"]))
    rows = [
        ("Overdue premiums", _pkr(ctx.get("premiums"))),
        ("Late-payment surcharge", _pkr(ctx.get("surcharges"))),
    ]
    if (ctx.get("interest") or 0) > 0:
        rows.append(("Interest", _pkr(ctx.get("interest"))))
    if (ctx.get("fee") or 0) > 0:
        rows.append(("Reinstatement fee", _pkr(ctx.get("fee"))))
    rows += [("Total received", _pkr(ctx.get("total"))), ("Payment reference", ctx.get("payment_reference") or "—")]
    story.append(_kv_table(rows))

    if terms.get("loading_pct") or terms.get("exclusions"):
        story.append(Spacer(1, 8))
        story.append(Paragraph("Revised terms accepted", ss["H"]))
        term_rows = []
        if terms.get("loading_pct"):
            term_rows.append(("Premium loading", f"{terms['loading_pct']:g}% "
                              f"(+{_pkr(terms.get('additional_annual_premium'))} per year)"))
        if terms.get("exclusions"):
            term_rows.append(("Exclusions", terms["exclusions"]))
        story.append(_kv_table(term_rows))

    story.append(Spacer(1, 8))
    story.append(Paragraph("Important", ss["H"]))
    story.append(Paragraph(
        f"No insurance cover was in force between <b>{ctx.get('lapse_date') or 'the lapse date'}</b> and "
        f"<b>{ctx.get('effective_date') or 'the reinstatement date'}</b>. Claims arising from events during that "
        "period are not covered. Reinstatement was granted on the basis of the signed declaration of good health; "
        "any misstatement or non-disclosure may void the policy.", ss["Body"]))
    story += _footer(ss)
    _build(path, story)
    return {"document_name": f"Reinstatement {case_no}", "file_path": path}


def generate_renewal_notice(ctx: dict) -> dict:
    """Render the renewal notice PDF — what is due, when, how to pay and what happens
    if it is missed. Works for both a Premium Renewal and a Contract Renewal.
    Returns {document_name, file_path}."""
    from services import insurer_config
    ss = _styles()
    pid = ctx["policy_id"]
    tenant_name = ctx.get("tenant_name", "Insurer")
    no = ctx.get("renewal_no", "RW")
    out_dir = os.path.join(MEDIA_ROOT, str(pid))
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"renewal_notice_{no}.pdf")

    contract = ctx.get("renewal_type") == "ContractRenewal"
    story: list = []
    story += _header(ss, tenant_name, "Contract Renewal Notice" if contract else "Premium Renewal Notice",
                     f"Policy {ctx.get('policy_number', '—')} · {no}")
    story.append(Paragraph(f"Dear {ctx.get('customer_name') or 'Policyholder'},", ss["Body"]))
    if contract:
        story.append(Paragraph(
            "Your insurance contract is due for renewal. Subject to the terms below, cover can continue for "
            f"another period from <b>{ctx.get('period_start') or ctx.get('due_date')}</b> to "
            f"<b>{ctx.get('period_end') or '—'}</b>.", ss["Body"]))
    else:
        story.append(Paragraph(
            "A premium on your policy is falling due. Your policy continues unchanged — this notice is a reminder "
            "to pay the premium shown below by the due date.", ss["Body"]))
    story.append(Spacer(1, 6))
    rows = [
        ("Policy Number", ctx.get("policy_number") or "—"),
        ("Product", ctx.get("product_name") or "—"),
        ("Sum Assured", _pkr(ctx.get("sum_assured"))),
        ("Due Date", str(ctx.get("due_date") or "—")),
        ("Premium Payable", _pkr(ctx.get("amount"))),
        ("Billing Mode", str(ctx.get("frequency") or "—")),
    ]
    if contract and ctx.get("new_annual") is not None:
        rows.append(("Renewed Annual Premium", _pkr(ctx.get("new_annual"))))
    story.append(_card_table(rows, title="Renewal Details"))
    story.append(Spacer(1, 8))
    story.append(Paragraph("How to pay", ss["H"]))
    for ch in insurer_config.PAYMENT_CHANNELS:
        story.append(Paragraph(f"<b>{ch['label']}</b> — {ch['detail']}", ss["Body"]))
    story.append(Spacer(1, 6))
    story.append(Paragraph(insurer_config.NOTICE_GRACE_LAPSE, ss["Fine"]))
    if contract:
        story.append(Paragraph(
            "Renewal of the contract is subject to your acceptance of the renewed terms and to any underwriting "
            "evaluation required by the product.", ss["Fine"]))
    story += _footer(ss)
    _build(path, story)
    return {"document_name": f"Renewal Notice {no}", "file_path": path}


def generate_renewal_confirmation(ctx: dict) -> dict:
    """Render the renewal confirmation PDF — a premium-renewal acknowledgement or the
    renewed-contract schedule. Returns {document_name, file_path}."""
    ss = _styles()
    pid = ctx["policy_id"]
    tenant_name = ctx.get("tenant_name", "Insurer")
    no = ctx.get("renewal_no", "RW")
    out_dir = os.path.join(MEDIA_ROOT, str(pid))
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"renewal_confirmation_{no}.pdf")

    contract = ctx.get("renewal_type") == "ContractRenewal"
    story: list = []
    story += _header(ss, tenant_name, "Contract Renewal Confirmation" if contract else "Premium Renewal Confirmation",
                     f"Policy {ctx.get('policy_number', '—')} · {no}")
    story.append(Paragraph(f"Dear {ctx.get('customer_name') or 'Policyholder'},", ss["Body"]))
    story.append(Paragraph(
        ("Your insurance contract has been <b>renewed</b>. The updated schedule is below."
         if contract else
         "We confirm receipt of your premium. Your policy remains in force on its existing terms."), ss["Body"]))
    story.append(Spacer(1, 6))
    rows = [
        ("Policy Number", ctx.get("policy_number") or "—"),
        ("Product", ctx.get("product_name") or "—"),
        ("Sum Assured", _pkr(ctx.get("sum_assured"))),
        ("Premium Received", _pkr(ctx.get("amount_received"))),
        ("Payment Reference", ctx.get("payment_reference") or "—"),
        ("Receipt No.", ctx.get("receipt_no") or "—"),
    ]
    if contract:
        rows += [("Renewed Period", f"{ctx.get('period_start', '—')} to {ctx.get('period_end', '—')}"),
                 ("Policy Version", str(ctx.get("version_number") or "—")),
                 ("Annual Premium", _pkr(ctx.get("new_annual")))]
        if ctx.get("loading_pct"):
            rows.append(("Premium Loading", f"{ctx['loading_pct']:g}%"))
    if ctx.get("next_due_date"):
        rows.append(("Next Premium Due", str(ctx["next_due_date"])))
    story.append(_card_table(rows, title="Renewal Details"))
    story += _footer(ss)
    _build(path, story)
    return {"document_name": f"Renewal Confirmation {no}", "file_path": path}


def generate_claim_checklist(ctx: dict) -> dict:
    """Render the claim document checklist handed to the claimant: what to submit, what is
    already received, and the service level once the file is complete.
    Returns {document_name, file_path}."""
    ss = _styles()
    pid = ctx["policy_id"]
    tenant_name = ctx.get("tenant_name", "Insurer")
    no = ctx.get("claim_number", "CLM")
    out_dir = os.path.join(MEDIA_ROOT, str(pid))
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"claim_checklist_{no}.pdf")

    story: list = []
    story += _header(ss, tenant_name, "Claim Document Checklist", f"Claim {no} · Policy {ctx.get('policy_number', '—')}")
    story.append(Paragraph(f"Dear {ctx.get('claimant_name') or 'Claimant'},", ss["Body"]))
    story.append(Paragraph(
        f"We have registered your <b>{ctx.get('claim_label', 'claim')}</b> for an event on <b>{ctx.get('event_date', '—')}</b>. "
        "Please submit the documents below. Your claim is normally decided within "
        f"<b>{ctx.get('sla_days', 7)} working days</b> of receiving the complete set; additional verification can extend this.",
        ss["Body"]))
    story.append(Spacer(1, 6))
    data = [[Paragraph("<b>Document</b>", ss["Body"]), Paragraph("<b>Needed</b>", ss["Body"]), Paragraph("<b>Status</b>", ss["Body"])]]
    for d in ctx.get("documents", []):
        data.append([Paragraph(d["label"] + (f"<br/><font size=7 color='#64748b'>{d['reason']}</font>" if d.get("reason") else ""), ss["Body"]),
                     Paragraph("Required" if d.get("required") else "If asked", ss["Body"]),
                     Paragraph(d.get("status", "Requested"), ss["Body"])])
    t = Table(data, colWidths=[100 * mm, 28 * mm, 32 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(t)
    story.append(Spacer(1, 8))
    story.append(Paragraph("Original documents may be needed for verification. Misstatement or concealment of facts can void the claim.", ss["Fine"]))
    story += _footer(ss)
    _build(path, story)
    return {"document_name": f"Claim Checklist {no}", "file_path": path}


def generate_claim_letter(ctx: dict) -> dict:
    """Render the closing letter of a claim — a settlement confirmation or a rejection
    notice with the reason and the way to escalate. Returns {document_name, file_path}."""
    from services import insurer_config
    ss = _styles()
    pid = ctx["policy_id"]
    tenant_name = ctx.get("tenant_name", "Insurer")
    no = ctx.get("claim_number", "CLM")
    out_dir = os.path.join(MEDIA_ROOT, str(pid))
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"claim_letter_{no}.pdf")

    settled = ctx.get("outcome") == "Settled"
    story: list = []
    story += _header(ss, tenant_name, "Claim Settlement Confirmation" if settled else "Claim Decision",
                     f"Claim {no} · Policy {ctx.get('policy_number', '—')}")
    story.append(Paragraph(f"Dear {ctx.get('claimant_name') or 'Claimant'},", ss["Body"]))
    rows = [("Claim", f"{no} — {ctx.get('claim_label', '')}"), ("Event Date", str(ctx.get("event_date") or "—")),
            ("Covered Person", ctx.get("covered_person") or "—"), ("Amount Claimed", _pkr(ctx.get("claimed_amount")))]
    if settled:
        story.append(Paragraph("Your claim has been <b>approved and paid</b>. Details are below.", ss["Body"]))
        rows += [("Benefit Approved", _pkr(ctx.get("approved_amount"))), ("Total Paid", _pkr(ctx.get("paid_amount")))]
        story.append(Spacer(1, 6))
        story.append(_card_table(rows, title="Claim Details"))
        story.append(Spacer(1, 8))
        story.append(Paragraph("Payments", ss["H"]))
        pay = [[Paragraph("<b>Payee</b>", ss["Body"]), Paragraph("<b>Amount</b>", ss["Body"]), Paragraph("<b>Reference</b>", ss["Body"])]]
        for p in ctx.get("payouts", []):
            pay.append([Paragraph(p.get("payee_name") or "—", ss["Body"]), Paragraph(_pkr(p.get("amount")), ss["Body"]),
                        Paragraph(p.get("reference_number") or "—", ss["Body"])])
        t = Table(pay, colWidths=[70 * mm, 40 * mm, 50 * mm])
        t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
                               ("LINEBELOW", (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
                               ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
        story.append(t)
        if ctx.get("deductions"):
            story.append(Spacer(1, 6))
            story.append(Paragraph("Adjustments made to the benefit", ss["H"]))
            for d in ctx["deductions"]:
                story.append(Paragraph(f"{d['label']}: {_pkr(d['amount'])}", ss["Body"]))
        if ctx.get("coverage_note"):
            story.append(Spacer(1, 6))
            story.append(Paragraph(ctx["coverage_note"], ss["Body"]))
    else:
        story.append(Paragraph("After careful review we are <b>unable to accept this claim</b>.", ss["Body"]))
        story.append(Spacer(1, 6))
        story.append(_card_table(rows, title="Claim Details"))
        story.append(Spacer(1, 8))
        story.append(Paragraph("Reason", ss["H"]))
        story.append(Paragraph(ctx.get("reason") or "—", ss["Body"]))
        story.append(Spacer(1, 6))
        story.append(Paragraph(insurer_config.NOTICE_GRIEVANCE, ss["Fine"]))
    story += _footer(ss)
    _build(path, story)
    return {"document_name": f"Claim Letter {no}", "file_path": path}


def generate_exit_statement(ctx: dict) -> dict:
    """Render the settlement statement a policyholder is asked to accept — how the maturity
    or surrender amount was reached, what was deducted, and until when the figure holds.
    Returns {document_name, file_path}."""
    ss = _styles()
    pid = ctx["policy_id"]
    tenant_name = ctx.get("tenant_name", "Insurer")
    no = ctx.get("exit_no", "EX")
    out_dir = os.path.join(MEDIA_ROOT, str(pid))
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"exit_statement_{no}.pdf")
    s = ctx["settlement"]
    surrender = ctx.get("exit_type") == "Surrender"

    story: list = []
    story += _header(ss, tenant_name, "Surrender Settlement Statement" if surrender else "Maturity Settlement Statement",
                     f"Policy {ctx.get('policy_number', '—')} · {no}")
    story.append(Paragraph(f"Dear {ctx.get('customer_name') or 'Policyholder'},", ss["Body"]))
    story.append(Paragraph(
        ("Below is the amount payable if you surrender your policy. Surrender ends all cover and cannot be undone."
         if surrender else "Your policy has reached maturity. Below is the amount payable under it."), ss["Body"]))
    story.append(Spacer(1, 6))
    story.append(_card_table([
        ("Policy Number", ctx.get("policy_number") or "—"), ("Product", ctx.get("product_name") or "—"),
        ("Valued On", str(s.get("valuation_date"))), ("Completed Policy Years", str(s.get("completed_years"))),
        ("Premiums Paid", _pkr(s["fund"]["premiums_paid"])),
    ], title="Policy"))
    story.append(Spacer(1, 8))
    story.append(Paragraph("How the amount was reached", ss["H"]))
    rows = [("Basis", s["basis"])] + [(ln["label"], ("− " if ln["amount"] < 0 else "") + _pkr(abs(ln["amount"]))) for ln in s["lines"]]
    rows.append(("Gross value", _pkr(s["gross"])))
    story.append(_kv_table(rows))
    if s["deductions"]:
        story.append(Spacer(1, 6))
        story.append(Paragraph("Deductions", ss["H"]))
        story.append(_kv_table([(d["label"], "− " + _pkr(d["amount"])) for d in s["deductions"]]))
    if s.get("tax"):
        story.append(_kv_table([(f"Tax withheld ({s['tax_pct']:g}%)", "− " + _pkr(s["tax"]))]))
    story.append(Spacer(1, 6))
    story.append(_card_table([("NET AMOUNT PAYABLE", _pkr(s["net"]))]))
    if s.get("shortfall"):
        story.append(Spacer(1, 4))
        story.append(Paragraph(f"The deductions exceed the value by {_pkr(s['shortfall'])}; nothing is payable.", ss["Body"]))
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        f"This figure is valid until <b>{ctx.get('valid_until') or '—'}</b>. By accepting it you confirm the amount and the deductions above.", ss["Body"]))
    story += _footer(ss)
    _build(path, story)
    return {"document_name": f"Settlement Statement {no}", "file_path": path}


def generate_exit_letter(ctx: dict) -> dict:
    """Render the closing letter of a policy: maturity, surrender, expiry, corporate expiry or the
    closure after a death claim — final coverage end, what was paid, billing stopped.
    Returns {document_name, file_path}."""
    ss = _styles()
    pid = ctx["policy_id"]
    tenant_name = ctx.get("tenant_name", "Insurer")
    no = ctx.get("exit_no", "EX")
    out_dir = os.path.join(MEDIA_ROOT, str(pid))
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"exit_letter_{no}.pdf")
    t = ctx.get("exit_type")
    title = {"Maturity": "Policy Maturity Confirmation", "Surrender": "Policy Surrender Confirmation", "Expiry": "Policy Expiry Notice",
             "CorporateExpiry": "Group Cover Expiry Notice", "DeathClaimClosure": "Policy Closure Confirmation"}.get(t, "Policy Closure")
    intro = {
        "Maturity": "Your policy has matured and the maturity benefit has been paid. The policy is now closed.",
        "Surrender": "Your policy has been surrendered and the net surrender value has been paid. The policy is now closed and cover has ended.",
        "Expiry": "Your policy has reached the end of its term. As a protection-only plan it carries no maturity benefit, and it is now closed.",
        "CorporateExpiry": "The group master policy under which you were covered has ended and was not renewed. Your certificate of insurance is now closed.",
        "DeathClaimClosure": "Following the settlement of the death claim, your policy has been formally closed.",
    }.get(t, "Your policy has been closed.")

    story: list = []
    story += _header(ss, tenant_name, title, f"Policy {ctx.get('policy_number', '—')} · {no}")
    story.append(Paragraph(f"Dear {ctx.get('customer_name') or 'Policyholder'},", ss["Body"]))
    story.append(Paragraph(intro, ss["Body"]))
    story.append(Spacer(1, 6))
    rows = [("Policy Number", ctx.get("policy_number") or "—"), ("Product", ctx.get("product_name") or "—"),
            ("Final Status", ctx.get("final_status") or "—"), ("Cover Ended", str(ctx.get("coverage_ended") or "—")),
            ("Closure Reference", no)]
    story.append(_card_table(rows, title="Closure Details"))
    if ctx.get("payouts"):
        story.append(Spacer(1, 8))
        story.append(Paragraph("Payment", ss["H"]))
        for p in ctx["payouts"]:
            story.append(Paragraph(f"{_pkr(p.get('amount'))} paid to <b>{p.get('payee_name')}</b> by {p.get('method')} — reference {p.get('reference')}", ss["Body"]))
        if ctx.get("net"):
            story.append(Paragraph(f"Gross value {_pkr(ctx.get('gross'))}, less deductions {_pkr(ctx.get('deductions'))}"
                                   + (f" and tax {_pkr(ctx.get('tax'))}" if ctx.get("tax") else "") + ".", ss["Fine"]))
    story.append(Spacer(1, 8))
    story.append(Paragraph("What happens next", ss["H"]))
    bits = ["No further premiums will be billed on this policy and any scheduled reminders have been stopped."]
    if ctx.get("instalments_waived"):
        bits.append(f"{ctx['instalments_waived']} unpaid instalment(s) were cancelled.")
    if ctx.get("riders_closed"):
        bits.append(f"{ctx['riders_closed']} rider(s) ended with the policy.")
    bits.append("A permanent record of this policy and its closure is retained by the company.")
    for b in bits:
        story.append(Paragraph("• " + b, ss["Body"]))
    story += _footer(ss)
    _build(path, story)
    return {"document_name": f"Policy Closure {no}", "file_path": path}
