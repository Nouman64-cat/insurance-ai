#!/usr/bin/env python3
"""Generate sample-documents/3_family_group_full_details.pdf — demo data for the family
group "Add New Family" form (Upload document). It carries everything the three tabs ask for:
the household, the policy being proposed, and every member.

Run from the repository root:  python sample-documents/generate_family_pdf.py
"""

import os

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import HRFlowable, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

FAMILY = [
    ("Family Name", "Qureshi Family"),
    ("Contact Person (Proposer)", "Imran Qureshi"),
    ("Contact Email", "imran.qureshi@example.com"),
    ("Contact Phone", "0300-4412876"),
    ("Household Annual Income (PKR)", "4,800,000"),
    ("City", "Lahore"),
    ("Province", "Punjab"),
]

POLICY = [
    ("Policy Type", "Health Floater (one shared sum insured for the whole family)"),
    ("Total Sum Insured (PKR)", "5,000,000"),
    ("Term (years)", "1"),
    ("Effective Date", "2026-11-01"),
]

MEMBER_HEADERS = ["Relationship", "Full Name", "CNIC", "Date of Birth", "Gender", "Occupation", "Annual Income (PKR)",
                  "Fully Insured?", "Nominee Share", "Smoker / Height / Weight"]
# Only the head (Self) and — if the family wants — the spouse are insured and underwritten. Everyone else is a
# nominee: no cover, no medical, just their share of the head's death benefit (shares total 100%).
MEMBERS = [
    ["Self (head)", "Imran Qureshi", "35202-6104473-5", "1985-06-12", "Male", "Software Engineer", "3,600,000", "Yes", "—", "No / 176 cm / 79 kg"],
    ["Spouse", "Ayesha Qureshi", "35202-7731508-2", "1988-09-21", "Female", "School Teacher", "1,200,000", "Yes", "50%", "No / 162 cm / 61 kg"],
    ["Child", "Hamza Qureshi", "—", "2014-03-05", "Male", "—", "—", "No (nominee)", "25%", "—"],
    ["Child", "Zainab Qureshi", "—", "2017-11-18", "Female", "—", "—", "No (nominee)", "25%", "—"],
]


def build(output_path: str) -> None:
    doc = SimpleDocTemplate(output_path, pagesize=letter, leftMargin=36, rightMargin=36, topMargin=36, bottomMargin=36)
    styles = getSampleStyleSheet()
    ink, slate = colors.HexColor("#0f172a"), colors.HexColor("#475569")
    title = ParagraphStyle("T", parent=styles["Heading1"], fontName="Helvetica-Bold", fontSize=18, leading=22, textColor=ink, spaceAfter=2)
    subtitle = ParagraphStyle("S", parent=styles["Normal"], fontName="Helvetica", fontSize=9, leading=12, textColor=colors.HexColor("#64748b"), spaceAfter=8)
    label = ParagraphStyle("L", fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=slate)
    value = ParagraphStyle("V", fontName="Helvetica", fontSize=8.5, leading=11, textColor=ink)
    head = ParagraphStyle("H", fontName="Helvetica-Bold", fontSize=7.5, leading=9, textColor=colors.HexColor("#1e3a8a"))
    cell = ParagraphStyle("C", fontName="Helvetica", fontSize=7.5, leading=9.5, textColor=ink)

    def banner(text: str):
        t = Table([[Paragraph(f"<b>{text.upper()}</b>", ParagraphStyle("B", fontName="Helvetica-Bold", fontSize=9, leading=11, textColor=colors.HexColor("#1e3a8a")))]], colWidths=[540])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#eff6ff")), ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#bfdbfe")),
            ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4), ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ]))
        return t

    def kv(pairs):
        rows = []
        for i in range(0, len(pairs), 2):
            row = [Paragraph(pairs[i][0], label), Paragraph(pairs[i][1], value)]
            row += [Paragraph(pairs[i + 1][0], label), Paragraph(pairs[i + 1][1], value)] if i + 1 < len(pairs) else ["", ""]
            rows.append(row)
        t = Table(rows, colWidths=[130, 140, 130, 140])
        t.setStyle(TableStyle([
            ("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")), ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#f1f5f9")),
            ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]))
        return t

    story = []
    meta = ParagraphStyle("M", fontName="Helvetica", fontSize=7.5, leading=10, textColor=slate, alignment=2)
    header = Table([[Paragraph("<b>FAMILY INSURANCE PROPOSAL FORM</b>", title),
                     Paragraph("<b>FORM ID:</b> FAM-2026-1006-LHR<br/><b>DATE:</b> 2026-10-06<br/><b>STATUS:</b> COMPLETED", meta)]], colWidths=[380, 160])
    header.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    story += [header,
              Paragraph("Sample document with <b>ALL 3 TABS</b> of the Add New Family form populated — head, an insured spouse and two nominees (demo data)", subtitle),
              HRFlowable(width="100%", thickness=1.5, color=colors.HexColor("#2563eb"), spaceBefore=0, spaceAfter=8)]

    story += [banner("1. Family Details"), Spacer(1, 3), kv(FAMILY), Spacer(1, 10)]
    story += [banner("2. Policy Type & Terms"), Spacer(1, 3), kv(POLICY), Spacer(1, 10)]

    story += [banner("3. Family Members (head, spouse and nominees)"), Spacer(1, 3)]
    data = [[Paragraph(h, head) for h in MEMBER_HEADERS]] + [[Paragraph(c, cell) for c in row] for row in MEMBERS]
    widths = [46, 62, 72, 52, 36, 56, 52, 44, 40, 80]
    table = Table(data, colWidths=widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eff6ff")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")), ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#f1f5f9")),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
    ]))
    story += [table, Spacer(1, 6),
              Paragraph("Only the head and the spouse are insured and underwritten. Children are nominees: they carry no cover and no income. "
                        "Nominee shares are percentages of the head's death benefit and total 100%.",
                        ParagraphStyle("N", fontName="Helvetica-Oblique", fontSize=7.5, leading=10, textColor=slate)),
              Spacer(1, 14)]

    story.append(Paragraph(
        "<b>Proposer Declaration:</b> I declare that the information given for myself and every member of my family in this form is true, "
        "correct and complete, and I understand it forms the basis of the underwriting of each member.",
        ParagraphStyle("D", fontName="Helvetica", fontSize=7.5, leading=10, textColor=slate)))
    story.append(Spacer(1, 12))
    sig = Table([[Paragraph("<b>Proposer Signature:</b> <u>Imran Qureshi</u>", value), Paragraph("<b>Date:</b> 2026-10-06", value),
                  Paragraph("<b>Agent Signature:</b> <u>Verified Agent</u>", value)]], colWidths=[200, 140, 200])
    sig.setStyle(TableStyle([("LINEABOVE", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")), ("TOPPADDING", (0, 0), (-1, -1), 6)]))
    story.append(sig)

    doc.build(story)
    print(f"Successfully generated: {output_path}")


if __name__ == "__main__":
    build(os.path.join(os.path.dirname(os.path.abspath(__file__)), "3_family_group_full_details.pdf"))
