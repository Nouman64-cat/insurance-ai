#!/usr/bin/env python3
"""Generate sample-documents/1_full_details_customer.pdf with all 8 tab fields."""

import os
from reportlab.lib.pagesizes import letter
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether, HRFlowable
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors

def create_full_customer_pdf(output_path: str):
    doc = SimpleDocTemplate(
        output_path,
        pagesize=letter,
        leftMargin=36,
        rightMargin=36,
        topMargin=36,
        bottomMargin=36
    )

    styles = getSampleStyleSheet()

    # Custom styles
    title_style = ParagraphStyle(
        'DocTitle',
        parent=styles['Heading1'],
        fontName='Helvetica-Bold',
        fontSize=18,
        leading=22,
        textColor=colors.HexColor('#0f172a'),
        spaceAfter=2
    )

    subtitle_style = ParagraphStyle(
        'DocSubtitle',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=9,
        leading=12,
        textColor=colors.HexColor('#64748b'),
        spaceAfter=8
    )

    section_header_style = ParagraphStyle(
        'SectionHeader',
        parent=styles['Heading2'],
        fontName='Helvetica-Bold',
        fontSize=11,
        leading=14,
        textColor=colors.HexColor('#1e40af'),
        spaceBefore=6,
        spaceAfter=4
    )

    label_style = ParagraphStyle(
        'FieldLabel',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=8.5,
        leading=11,
        textColor=colors.HexColor('#334155')
    )

    val_style = ParagraphStyle(
        'FieldValue',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=8.5,
        leading=11,
        textColor=colors.HexColor('#0f172a')
    )

    table_cell_label = ParagraphStyle(
        'TCLabel',
        fontName='Helvetica-Bold',
        fontSize=8,
        leading=10,
        textColor=colors.HexColor('#475569')
    )

    table_cell_val = ParagraphStyle(
        'TCVal',
        fontName='Helvetica',
        fontSize=8.5,
        leading=11,
        textColor=colors.HexColor('#0f172a')
    )

    def section_banner(title_text: str):
        data = [[Paragraph(f"<b>{title_text.upper()}</b>", ParagraphStyle(
            'BannerText',
            fontName='Helvetica-Bold',
            fontSize=9,
            leading=11,
            textColor=colors.HexColor('#1e3a8a')
        ))]]
        t = Table(data, colWidths=[540])
        t.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#eff6ff')),
            ('BOX', (0, 0), (-1, -1), 0.5, colors.HexColor('#bfdbfe')),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ('LEFTPADDING', (0, 0), (-1, -1), 8),
            ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ]))
        return t

    def make_kv_table(pairs, cols=2):
        """pairs is list of (label, value). cols is 2 or 3."""
        if cols == 2:
            data = []
            for i in range(0, len(pairs), 2):
                row = []
                p1 = pairs[i]
                row.extend([Paragraph(p1[0], table_cell_label), Paragraph(str(p1[1]), table_cell_val)])
                if i + 1 < len(pairs):
                    p2 = pairs[i+1]
                    row.extend([Paragraph(p2[0], table_cell_label), Paragraph(str(p2[1]), table_cell_val)])
                else:
                    row.extend(["", ""])
                data.append(row)
            col_widths = [110, 160, 110, 160]
        else: # cols == 3
            data = []
            for i in range(0, len(pairs), 3):
                row = []
                for j in range(3):
                    if i + j < len(pairs):
                        p = pairs[i + j]
                        row.extend([Paragraph(p[0], table_cell_label), Paragraph(str(p[1]), table_cell_val)])
                    else:
                        row.extend(["", ""])
                data.append(row)
            col_widths = [80, 100, 80, 100, 80, 100]

        t = Table(data, colWidths=col_widths)
        t.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#ffffff')),
            ('ROWBACKGROUNDS', (0, 0), (-1, -1), [colors.HexColor('#ffffff'), colors.HexColor('#f8fafc')]),
            ('BOX', (0, 0), (-1, -1), 0.5, colors.HexColor('#e2e8f0')),
            ('INNERGRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#f1f5f9')),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
            ('LEFTPADDING', (0, 0), (-1, -1), 6),
            ('RIGHTPADDING', (0, 0), (-1, -1), 6),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ]))
        return t

    story = []

    # Document Header
    header_data = [
        [
            Paragraph("<b>CUSTOMER APPLICATION & DIAGNOSTIC FORM</b>", title_style),
            Paragraph("<b>FORM ID:</b> APP-2026-0914-LHR<br/><b>DATE:</b> 2026-10-01<br/><b>STATUS:</b> COMPLETED", ParagraphStyle(
                'HeadMeta', fontName='Helvetica', fontSize=7.5, leading=10, textColor=colors.HexColor('#475569'), alignment=2
            ))
        ]
    ]
    header_table = Table(header_data, colWidths=[380, 160])
    header_table.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
    ]))
    story.append(header_table)
    story.append(Paragraph("Sample document with <b>ALL 8 TABS</b> fully populated (demo data for onboarding test)", subtitle_style))
    story.append(HRFlowable(width="100%", thickness=1.5, color=colors.HexColor('#2563eb'), spaceBefore=0, spaceAfter=8))

    # ── TAB 1: IDENTITY & CONTACT ──────────────────────────────────────────
    story.append(section_banner("1. Identity & Contact Details (Demographics)"))
    story.append(Spacer(1, 3))
    pairs_tab1 = [
        ("First Name", "Ahmed"),
        ("Last Name", "Raza"),
        ("CNIC Number", "35202-4567891-3"),
        ("Date of Birth", "1988-03-15"),
        ("Gender", "Male"),
        ("Marital Status", "Married"),
        ("Mobile Number", "0321-5557788"),
        ("Email Address", "ahmed.raza@example.com"),
        ("Emergency Contact Name", "Sana Raza"),
        ("Postal Code", "54660"),
        ("Street Address", "House 24, Street 7, Gulberg III"),
        ("City / Province", "Lahore, Punjab"),
    ]
    story.append(make_kv_table(pairs_tab1, cols=2))
    story.append(Spacer(1, 8))

    # ── TAB 2: CNIC & DOCS ──────────────────────────────────────────────────
    story.append(section_banner("2. CNIC Identity & Documentation Details"))
    story.append(Spacer(1, 3))
    pairs_tab2 = [
        ("CNIC Issue Date", "2018-05-10"),
        ("CNIC Expiry Date", "2028-05-10"),
        ("Validation Status", "Valid"),
        ("Document Verification", "Verified & Scanned (Front + Back on file)"),
    ]
    story.append(make_kv_table(pairs_tab2, cols=2))
    story.append(Spacer(1, 8))

    # ── TAB 3: OCCUPATION & INCOME ──────────────────────────────────────────
    story.append(section_banner("3. Occupation, Employment & Income Record"))
    story.append(Spacer(1, 3))
    pairs_tab3 = [
        ("Employment Type", "Salaried"),
        ("Occupation", "Software Engineer"),
        ("Employer Name", "TechLogix Systems"),
        ("Industry Sector", "Information Technology"),
        ("Years of Experience", "8"),
        ("Occupation Hazard Level", "Low"),
        ("Declared Annual Income", "3,600,000 PKR"),
        ("Monthly Income Equivalent", "300,000 PKR"),
        ("Income Stability Score", "85"),
        ("Income Source", "Salary"),
    ]
    story.append(make_kv_table(pairs_tab3, cols=2))
    story.append(Spacer(1, 8))

    # ── TAB 4: MEDICAL & LIFESTYLE ──────────────────────────────────────────
    story.append(section_banner("4. Medical History & Physical Lifestyle Metrics"))
    story.append(Spacer(1, 3))
    pairs_tab4 = [
        ("Pre-Existing Conditions", "No"),
        ("Active Smoker", "No"),
        ("Diabetic Profile", "No"),
        ("Medical Conditions List", "None"),
        ("Height (cm)", "178"),
        ("Weight (kg)", "74"),
        ("Calculated BMI", "23.4"),
        ("Exercise Frequency", "Moderate"),
    ]
    story.append(make_kv_table(pairs_tab4, cols=2))

    # Page Break to Page 2
    story.append(PageBreak())

    # Page 2 Header
    p2_header = Table([
        [
            Paragraph("<b>CUSTOMER APPLICATION FORM — PAGE 2</b>", ParagraphStyle('P2Title', fontName='Helvetica-Bold', fontSize=12, leading=15, textColor=colors.HexColor('#0f172a'))),
            Paragraph("<b>APPLICANT:</b> Ahmed Raza | CNIC: 35202-4567891-3", ParagraphStyle('P2Sub', fontName='Helvetica', fontSize=8, leading=11, textColor=colors.HexColor('#64748b'), alignment=2))
        ]
    ], colWidths=[320, 220])
    p2_header.setStyle(TableStyle([
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
    ]))
    story.append(p2_header)
    story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor('#2563eb'), spaceBefore=2, spaceAfter=8))

    # ── TAB 5: HABIT CHECK ──────────────────────────────────────────────────
    story.append(section_banner("5. Underwriting Habit Check & Behavioral Risk"))
    story.append(Spacer(1, 3))
    pairs_tab5 = [
        ("Smoking Status", "Non-smoker"),
        ("Alcohol Consumption", "None"),
        ("Recreational Drug History", "No"),
        ("Participates in Extreme Sports", "No"),
        ("Private Aviation (Non-Commercial)", "No"),
        ("Frequent High-Risk Travel", "No"),
        ("Travel Destinations (12 Mos)", "None"),
        ("Extreme Sports Details", "None"),
        ("Moving Violations (Past 3 Yrs)", "0"),
        ("DUI / DWI History", "No"),
        ("Criminal Record / Pending", "No"),
        ("Extreme Avocations Flag", "Clear / Low Risk"),
    ]
    story.append(make_kv_table(pairs_tab5, cols=2))
    story.append(Spacer(1, 8))

    # ── TAB 6: FINANCIAL PROFILE ────────────────────────────────────────────
    story.append(section_banner("6. Financial Standing, Credit & Dependents Profile"))
    story.append(Spacer(1, 3))
    pairs_tab6 = [
        ("Credit Score", "780"),
        ("Delinquencies Count", "0"),
        ("Credit Bureau Risk Grade", "Grade A"),
        ("Number of Dependents", "2"),
        ("Primary Dependent Type", "Child"),
        ("Bankruptcy / Default History", "None / Clean"),
    ]
    story.append(make_kv_table(pairs_tab6, cols=2))
    story.append(Spacer(1, 8))

    # ── TAB 7: NOMINEE DETAILS ──────────────────────────────────────────────
    story.append(section_banner("7. Designated Primary Nominee / Beneficiary Details"))
    story.append(Spacer(1, 3))
    pairs_tab7 = [
        ("Nominee First Name", "Sana"),
        ("Nominee Last Name", "Raza"),
        ("Nominee CNIC Number", "35202-9876543-2"),
        ("Relationship to Applicant", "Spouse"),
        ("Share Percentage (%)", "100"),
        ("Is Minor", "No"),
    ]
    story.append(make_kv_table(pairs_tab7, cols=2))
    story.append(Spacer(1, 8))

    # ── TAB 8: INSURANCE PLANS ──────────────────────────────────────────────
    story.append(section_banner("8. Insurance Plan Configuration & Coverage Request"))
    story.append(Spacer(1, 3))
    pairs_tab8 = [
        ("Selected Insurance Plan", "Salary Protection Plan"),
        ("Insurance Plan Type", "Term Life"),
        ("Requested Coverage Amount", "5,000,000 PKR"),
        ("Policy Term (Years)", "20"),
        ("Dependent Name", "None"),
        ("Dependent Date of Birth", "None"),
    ]
    story.append(make_kv_table(pairs_tab8, cols=2))
    story.append(Spacer(1, 14))

    # Signature Block & Declaration
    decl_text = (
        "<b>Applicant Declaration:</b> I hereby declare that all information furnished across Sections 1 through 8 "
        "of this document is true, correct, and complete to the best of my knowledge. I understand that this information "
        "forms the underwriting basis for the policy contract."
    )
    story.append(Paragraph(decl_text, ParagraphStyle('Decl', fontName='Helvetica', fontSize=7.5, leading=10, textColor=colors.HexColor('#475569'))))
    story.append(Spacer(1, 12))

    sig_data = [
        [
            Paragraph("<b>Applicant Signature:</b> <u>Ahmed Raza</u>", ParagraphStyle('Sig', fontName='Helvetica', fontSize=8.5, leading=11)),
            Paragraph("<b>Date:</b> 2026-10-01", ParagraphStyle('DateSig', fontName='Helvetica', fontSize=8.5, leading=11)),
            Paragraph("<b>Agent Signature:</b> <u>Verified Agent</u>", ParagraphStyle('AgSig', fontName='Helvetica', fontSize=8.5, leading=11)),
        ]
    ]
    sig_table = Table(sig_data, colWidths=[200, 140, 200])
    sig_table.setStyle(TableStyle([
        ('LINEABOVE', (0, 0), (-1, -1), 0.5, colors.HexColor('#cbd5e1')),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
        ('RIGHTPADDING', (0, 0), (-1, -1), 4),
    ]))
    story.append(sig_table)

    doc.build(story)
    print(f"Successfully generated: {output_path}")

if __name__ == "__main__":
    out_pdf = os.path.abspath("sample-documents/1_full_details_customer.pdf")
    create_full_customer_pdf(out_pdf)
