#!/usr/bin/env python3
"""Generate sample-documents/4_corporate_group_full_details.pdf — demo data for the corporate
"Add New Corporate" form (Upload document). It carries everything the four tabs ask for: the
company, the group policy being proposed, the benefit classes and the employee census.

Group Life needs at least 10 employees, so the census has 10. Covers stay under the Free Cover Limit
(~PKR 1,000,000 for a group this size), so the demo scheme is guaranteed-issue and goes straight to a quote.

Run from the repository root:  python sample-documents/generate_organization_pdf.py
"""

import os

from reportlab.lib import colors
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import HRFlowable, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

COMPANY = [
    ("Company Name", "Meridian Textiles Ltd"),
    ("Registration Number", "CUIN 0098765"),
    ("Industry", "Textiles"),
    ("Contact Person", "Sana Iqbal"),
    ("Contact Email", "hr@meridiantextiles.example.com"),
    ("Contact Phone", "0321-7745521"),
    ("City", "Lahore"),
    ("Province", "Punjab"),
]

POLICY = [
    ("Product", "Group Life"),
    ("Default Cover (x monthly basic salary)", "24"),
    ("Term (years)", "1"),
    ("Effective Date", "2026-11-01"),
]

CLASS_HEADERS = ["Class Name", "Basis", "Flat Amount (PKR)", "Salary Multiple", "Service Bands (years : cover PKR)", "Grades", "Max Cover (PKR)", "Default Class"]
CLASSES = [
    ["Management", "Flat", "1,000,000", "-", "-", "M1, M2", "-", "No"],
    ["Staff", "SalaryMultiple", "-", "12", "-", "S1, S2", "1,000,000", "No"],
    ["Workers", "ServiceBanded", "-", "-", "0 : 400,000; 3 : 600,000; 5 : 800,000", "W1, W2", "-", "Yes"],
]

BENEFIT_HEADERS = ["Class Name", "Extra Benefit", "% of Life Cover", "Max Cover (PKR)"]
BENEFITS = [
    ["Management", "Accidental Death", "100", "-"],
    ["Management", "Disability", "50", "500,000"],
    ["Staff", "Accidental Death", "100", "-"],
]

ID_HEADERS = ["Emp ID", "Full Name", "CNIC", "Date of Birth", "Gender", "Occupation", "Smoker", "Height (cm) / Weight (kg)"]
JOB_HEADERS = ["Emp ID", "Full Name", "Designation", "Grade", "Date Joined", "Annual Income (PKR)", "Monthly Basic Salary (PKR)", "Benefit Class"]
EMP_HEADERS = ["Emp ID", "Full Name", "CNIC", "Date of Birth", "Gender", "Occupation", "Designation", "Grade", "Joined",
               "Annual Income (PKR)", "Monthly Basic (PKR)", "Benefit Class", "Smoker", "Height (cm) / Weight (kg)"]
EMPLOYEES = [
    ["E001", "Tariq Mehmood", "35202-1840573-1", "1982-02-14", "Male", "Manager", "Head of Operations", "M1", "2015-03-01", "4,200,000", "350,000", "Management", "No", "178 / 84"],
    ["E002", "Nadia Farooq", "35202-2957126-8", "1986-07-30", "Female", "Manager", "Finance Manager", "M2", "2017-08-15", "3,600,000", "300,000", "Management", "No", "164 / 62"],
    ["E003", "Bilal Ahmed", "35201-5503918-3", "1991-11-05", "Male", "Accountant", "Senior Accountant", "S1", "2019-01-10", "960,000", "80,000", "Staff", "No", "172 / 70"],
    ["E004", "Hina Shah", "35201-7714052-6", "1993-04-22", "Female", "HR Executive", "HR Executive", "S2", "2020-06-01", "840,000", "70,000", "Staff", "No", "160 / 55"],
    ["E005", "Kamran Yousuf", "35201-3380592-9", "1990-08-11", "Male", "Sales Executive", "Sales Executive", "S2", "2021-03-15", "900,000", "75,000", "Staff", "No", "175 / 77"],
    ["E006", "Usman Ghani", "35202-9021647-4", "1988-12-09", "Male", "Machine Operator", "Loom Operator", "W1", "2018-09-03", "420,000", "35,000", "Workers", "Yes", "170 / 73"],
    ["E007", "Rashid Ali", "35201-4467203-7", "1995-05-17", "Male", "Supervisor", "Floor Supervisor", "W2", "2021-02-01", "480,000", "40,000", "Workers", "No", "173 / 68"],
    ["E008", "Shabana Noor", "35202-6618294-0", "1992-01-27", "Female", "Inspector", "Quality Inspector", "W1", "2022-05-10", "456,000", "38,000", "Workers", "No", "158 / 52"],
    ["E009", "Imtiaz Hussain", "35201-8825471-2", "1985-09-03", "Male", "Machine Operator", "Loom Operator", "W2", "2019-11-20", "480,000", "40,000", "Workers", "Yes", "169 / 76"],
    ["E010", "Farah Naz", "35202-1197365-5", "1996-12-14", "Female", "Packer", "Packing Hand", "W1", "2024-03-04", "384,000", "32,000", "Workers", "No", "161 / 54"],
]

DEP_HEADERS = ["Employee ID", "Employee", "Dependant Name", "Relationship", "Date of Birth", "CNIC", "Gender", "Covered Amount (PKR)"]
DEPENDANTS = [
    ["E001", "Tariq Mehmood", "Sadia Mehmood", "Spouse", "1984-05-09", "35202-4410982-6", "Female", "500,000"],
    ["E001", "Tariq Mehmood", "Ayaan Mehmood", "Child", "2012-08-21", "-", "Male", "250,000"],
    ["E002", "Nadia Farooq", "Omar Farooq", "Spouse", "1983-03-30", "35202-7209148-1", "Male", "500,000"],
    ["E003", "Bilal Ahmed", "Mariam Ahmed", "Spouse", "1994-07-14", "35201-6602817-4", "Female", "400,000"],
    ["E004", "Hina Shah", "Fatima Shah", "Parent", "1962-02-02", "35201-1285540-8", "Female", "200,000"],
    ["E007", "Rashid Ali", "Sana Rashid", "Spouse", "1996-10-10", "35201-9034471-0", "Female", "200,000"],
]

NOM_HEADERS = ["Employee ID", "Employee", "Nominee Name", "Relationship", "CNIC", "Share %", "Date of Birth", "Minor", "Guardian"]
NOMINEES = [
    ["E001", "Tariq Mehmood", "Sadia Mehmood", "Spouse", "35202-4410982-6", "60", "1984-05-09", "No", "-"],
    ["E001", "Tariq Mehmood", "Ayaan Mehmood", "Child", "-", "40", "2012-08-21", "Yes", "Sadia Mehmood"],
    ["E002", "Nadia Farooq", "Omar Farooq", "Spouse", "35202-7209148-1", "100", "1983-03-30", "No", "-"],
    ["E003", "Bilal Ahmed", "Mariam Ahmed", "Spouse", "35201-6602817-4", "100", "1994-07-14", "No", "-"],
    ["E004", "Hina Shah", "Hassan Shah", "Sibling", "35201-5547203-3", "60", "1997-06-18", "No", "-"],
    ["E004", "Hina Shah", "Shaista Shah", "Sibling", "35201-3390124-7", "40", "1999-11-02", "No", "-"],
    ["E006", "Usman Ghani", "Nusrat Ghani", "Spouse", "35202-3318760-2", "100", "1990-04-04", "No", "-"],
    ["E009", "Imtiaz Hussain", "Rubina Hussain", "Spouse", "35201-7741029-6", "100", "1988-02-19", "No", "-"],
]


def build(output_path: str) -> None:
    page = landscape(letter)
    doc = SimpleDocTemplate(output_path, pagesize=page, leftMargin=30, rightMargin=30, topMargin=30, bottomMargin=30)
    width = page[0] - 60
    styles = getSampleStyleSheet()
    ink, slate = colors.HexColor("#0f172a"), colors.HexColor("#475569")
    title = ParagraphStyle("T", parent=styles["Heading1"], fontName="Helvetica-Bold", fontSize=18, leading=22, textColor=ink, spaceAfter=2)
    subtitle = ParagraphStyle("S", parent=styles["Normal"], fontName="Helvetica", fontSize=9, leading=12, textColor=colors.HexColor("#64748b"), spaceAfter=8)
    label = ParagraphStyle("L", fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=slate)
    value = ParagraphStyle("V", fontName="Helvetica", fontSize=8.5, leading=11, textColor=ink)
    head = ParagraphStyle("H", fontName="Helvetica-Bold", fontSize=7, leading=8.5, textColor=colors.HexColor("#1e3a8a"))
    cell = ParagraphStyle("C", fontName="Helvetica", fontSize=7, leading=8.5, textColor=ink)
    # The census is the part that is read back digit by digit — keep it large and on a page of its own.
    head_big = ParagraphStyle("HB", fontName="Helvetica-Bold", fontSize=8.5, leading=10.5, textColor=colors.HexColor("#1e3a8a"))
    cell_big = ParagraphStyle("CB", fontName="Helvetica", fontSize=9, leading=11.5, textColor=ink)

    def banner(text: str):
        t = Table([[Paragraph(f"<b>{text.upper()}</b>", ParagraphStyle("B", fontName="Helvetica-Bold", fontSize=9, leading=11, textColor=colors.HexColor("#1e3a8a")))]], colWidths=[width])
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
        t = Table(rows, colWidths=[width * 0.22, width * 0.28, width * 0.22, width * 0.28])
        t.setStyle(TableStyle([
            ("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")), ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#f1f5f9")),
            ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]))
        return t

    def grid(headers, rows, widths, big=False):
        h_style, c_style = (head_big, cell_big) if big else (head, cell)
        data = [[Paragraph(h, h_style) for h in headers]] + [[Paragraph(c, c_style) for c in r] for r in rows]
        t = Table(data, colWidths=widths, repeatRows=1)
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eff6ff")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")), ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#f1f5f9")),
            ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ]))
        return t

    meta = ParagraphStyle("M", fontName="Helvetica", fontSize=7.5, leading=10, textColor=slate, alignment=2)
    header = Table([[Paragraph("<b>CORPORATE GROUP LIFE PROPOSAL FORM</b>", title),
                     Paragraph("<b>FORM ID:</b> CORP-2026-1007-LHR<br/><b>DATE:</b> 2026-10-07<br/><b>STATUS:</b> COMPLETED", meta)]], colWidths=[width - 160, 160])
    header.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))

    story = [header,
             Paragraph("Sample document with <b>ALL 6 TABS</b> of the Add New Corporate form populated (demo data for onboarding test)", subtitle),
             HRFlowable(width="100%", thickness=1.5, color=colors.HexColor("#2563eb"), spaceBefore=0, spaceAfter=8),
             banner("1. Company Details"), Spacer(1, 3), kv(COMPANY), Spacer(1, 8),
             banner("2. Group Policy"), Spacer(1, 3), kv(POLICY), Spacer(1, 8),
             banner("3. Benefit Classes (3 classes) and Extra Benefits"), Spacer(1, 3),
             grid(CLASS_HEADERS, CLASSES, [width * f for f in (0.12, 0.13, 0.12, 0.10, 0.24, 0.10, 0.11, 0.08)]), Spacer(1, 6),
             Paragraph("<b>Extra benefits by class</b> — each is a percentage of the class's life cover, optionally capped.", ParagraphStyle("EB", fontName="Helvetica", fontSize=8, leading=10, textColor=slate)), Spacer(1, 2),
             grid(BENEFIT_HEADERS, BENEFITS, [width * f for f in (0.25, 0.30, 0.20, 0.25)]), Spacer(1, 6),
             Paragraph("Workers are covered by years of service completed at the effective date: 0 years 400,000; 3 years 600,000; 5 years or more 800,000.",
                       ParagraphStyle("N0", fontName="Helvetica-Oblique", fontSize=7.5, leading=10, textColor=slate)),
             PageBreak(),
             banner("4. Employee Census (10 employees) — identity and health details"), Spacer(1, 3),
             grid(ID_HEADERS, [[r[0], r[1], r[2], r[3], r[4], r[5], r[12], r[13]] for r in EMPLOYEES], [width * f for f in (0.08, 0.15, 0.17, 0.12, 0.08, 0.16, 0.07, 0.17)], big=True), Spacer(1, 8),
             banner("4. Employee Census (continued) — employment and cover details"), Spacer(1, 3),
             grid(JOB_HEADERS, [[r[0], r[1], r[6], r[7], r[8], r[9], r[10], r[11]] for r in EMPLOYEES], [width * f for f in (0.08, 0.15, 0.17, 0.07, 0.12, 0.13, 0.14, 0.14)], big=True), Spacer(1, 6),
             Paragraph("Every employee's benefit class decides their cover. Free Cover Limit for a group of this size is about PKR 1,000,000, so every employee is guaranteed issue.",
                       ParagraphStyle("N", fontName="Helvetica-Oblique", fontSize=7.5, leading=10, textColor=slate)),
             PageBreak(),
             banner("5. Dependants Covered (6 dependants)"), Spacer(1, 3),
             grid(DEP_HEADERS, DEPENDANTS, [width * f for f in (0.09, 0.14, 0.16, 0.10, 0.12, 0.16, 0.08, 0.15)], big=True), Spacer(1, 10),
             banner("6. Nominees (8 nominees — shares per employee total 100%)"), Spacer(1, 3),
             grid(NOM_HEADERS, NOMINEES, [width * f for f in (0.09, 0.13, 0.15, 0.10, 0.15, 0.07, 0.12, 0.07, 0.12)], big=True), Spacer(1, 6),
             Paragraph("Nominees receive the death benefit but are not themselves covered. Employees without a nominee listed are nominated later.",
                       ParagraphStyle("N2", fontName="Helvetica-Oblique", fontSize=7.5, leading=10, textColor=slate)),
             Spacer(1, 14),
             Paragraph("<b>Employer Declaration:</b> I declare that the company, employee, dependant and nominee details in this form are true, correct and complete, and that every listed employee is in active service.",
                       ParagraphStyle("D", fontName="Helvetica", fontSize=7.5, leading=10, textColor=slate)),
             Spacer(1, 10)]
    sig = Table([[Paragraph("<b>Authorised Signatory:</b> <u>Sana Iqbal</u>", value), Paragraph("<b>Date:</b> 2026-10-07", value),
                  Paragraph("<b>Agent Signature:</b> <u>Verified Agent</u>", value)]], colWidths=[width * 0.4, width * 0.25, width * 0.35])
    sig.setStyle(TableStyle([("LINEABOVE", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")), ("TOPPADDING", (0, 0), (-1, -1), 6)]))
    story.append(sig)

    doc.build(story)
    print(f"Successfully generated: {output_path}")


if __name__ == "__main__":
    build(os.path.join(os.path.dirname(os.path.abspath(__file__)), "4_corporate_group_full_details.pdf"))
