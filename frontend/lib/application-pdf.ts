// Comprehensive "Insurance Application" dossier PDF — the final artifact
// produced after underwriting. Pulls together the applicant's personal, plan,
// occupational, medical, financial, nominee and document details plus the AI
// underwriting result into one downloadable A4 report.
//
// Fed from GET /tenants/{id}/cases/{id}/detail (same shape the case workbench
// renders), so everything is read straight off the case detail response.

const INSURANCE_TYPE_LABELS: Record<string, string> = {
  TERM_LIFE: "Term Life",
  WHOLE_LIFE: "Whole Life",
  ENDOWMENT: "Endowment / Savings Plan",
  CHILD_EDUCATION_MARRIAGE: "Child Education & Marriage Plan",
  GROUP_LIFE: "Group Life",
  SAVINGS: "Savings / Investment Plan",
  SINGLE_PREMIUM: "Single Premium Investment",
  HEALTH_CASH: "Hospital Cash / Health Plan",
};

const SOURCE_TYPE_LABELS: Record<string, string> = {
  AGENT: "Agent",
  BROKER: "Broker",
  BANCASSURANCE: "Bancassurance",
  CORPORATE_AGENT: "Corporate Agent",
  DIRECT: "Direct",
  DIGITAL: "Digital",
};

export interface ApplicationData {
  case: {
    caseNumber: string;
    caseType: string;
    caseStatus: string;
    priorityLevel: string;
    sourceChannel: string;
    createdAt: string;
  };
  customer: any | null;
  policy: any | null;
  document_checklist: { required: string[]; received: string[]; missing: string[] } | null;
  latest_assessment: any | null;
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-PK", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-PK", { day: "2-digit", month: "short", year: "numeric" })
    + " · " + d.toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" });
}

function fmtPKR(n?: number | null): string {
  if (n == null || isNaN(Number(n))) return "—";
  return "PKR " + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function ageFromDob(dob?: string | null): string {
  if (!dob) return "—";
  const d = new Date(dob);
  if (isNaN(d.getTime())) return "—";
  const yrs = Math.floor((Date.now() - d.getTime()) / 31557600000);
  return `${yrs} yrs`;
}

function scoreColorRGB(score: number): [number, number, number] {
  if (score <= 20) return [16, 185, 129];
  if (score <= 40) return [250, 204, 21];
  if (score <= 60) return [245, 158, 11];
  if (score <= 80) return [248, 113, 113];
  return [220, 38, 38];
}

export async function generateApplicationPDF(detail: ApplicationData) {
  const { default: jsPDF } = await import("jspdf");

  const logoImg = await new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.src = "/rizvi.png";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
  });

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210, mg = 16, cw = W - mg * 2;
  let y = 38;

  const { customer, policy, document_checklist: docs, latest_assessment: a, case: c } = detail;
  const d = (customer?.details ?? {}) as Record<string, any>;

  // ── low-level helpers ──────────────────────────────────────────────────────
  const nextPage = (needed: number) => {
    if (y + needed > 280) { doc.addPage(); y = mg; }
  };

  const section = (label: string) => {
    nextPage(16);
    y += 2;
    doc.setFont("helvetica", "bold").setFontSize(8).setTextColor(59, 130, 246);
    doc.text(label.toUpperCase(), mg, y);
    doc.setDrawColor(226, 232, 240);
    doc.line(mg, y + 1.5, W - mg, y + 1.5);
    y += 6;
  };

  // Draw one label/value field into a column of width colW at (x, y0). Returns
  // the height consumed so callers can lay out two columns per row.
  const field = (label: string, value: string, x: number, y0: number, colW: number): number => {
    doc.setFont("helvetica", "bold").setFontSize(6.5).setTextColor(148, 163, 184);
    doc.text(label.toUpperCase(), x, y0);
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(30, 41, 59);
    const wrapped = doc.splitTextToSize(value || "—", colW - 3);
    let yy = y0 + 4.2;
    for (const line of wrapped) { doc.text(line, x, yy); yy += 4; }
    return 4.2 + wrapped.length * 4 + 3;
  };

  // Lay out an array of {label,value} in two columns.
  const grid = (pairs: { label: string; value: string }[]) => {
    const colW = cw / 2;
    for (let i = 0; i < pairs.length; i += 2) {
      const left = pairs[i];
      const right = pairs[i + 1];
      nextPage(14);
      const hL = field(left.label, left.value, mg + 1, y, colW);
      const hR = right ? field(right.label, right.value, mg + colW + 3, y, colW) : 0;
      y += Math.max(hL, hR);
    }
    y += 1;
  };

  const paragraph = (text: string, size = 8.5) => {
    if (!text) return;
    const wrapped = doc.splitTextToSize(text, cw);
    nextPage(wrapped.length * 4.4 + 2);
    doc.setFont("helvetica", "normal").setFontSize(size).setTextColor(71, 85, 105);
    for (const line of wrapped) { doc.text(line, mg, y); y += 4.4; }
    y += 2;
  };

  const bullet = (text: string) => {
    const wrapped = doc.splitTextToSize(text, cw - 6);
    nextPage(wrapped.length * 4.4 + 1);
    doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(71, 85, 105);
    doc.setFillColor(59, 130, 246);
    doc.circle(mg + 1.5, y - 1, 0.7, "F");
    for (const line of wrapped) { doc.text(line, mg + 5, y); y += 4.4; }
    y += 1;
  };

  const emptyNote = (text: string) => {
    nextPage(6);
    doc.setFont("helvetica", "italic").setFontSize(8).setTextColor(148, 163, 184);
    doc.text(text, mg + 1, y);
    y += 5;
  };

  // ── Header band ────────────────────────────────────────────────────────────
  doc.setFillColor(255, 255, 255).rect(0, 0, W, 28, "F");
  doc.setFillColor(241, 245, 249).rect(0, 28, W, 1.5, "F");
  doc.setFillColor(59, 130, 246).rect(0, 28, W / 3, 1.5, "F");
  if (logoImg) doc.addImage(logoImg, "PNG", mg, 7.5, 36.2, 13);
  doc.setTextColor(15, 23, 42).setFont("helvetica", "bold").setFontSize(14);
  doc.text("INSURANCE APPLICATION", W - mg, 13, { align: "right" });
  doc.setFont("helvetica", "normal").setFontSize(7.5).setTextColor(100, 116, 139);
  doc.text("Complete Applicant Dossier", W - mg, 18.5, { align: "right" });
  doc.setTextColor(148, 163, 184).setFontSize(7);
  doc.text(`Case ${c.caseNumber}  ·  Generated ${fmtDateTime(new Date().toISOString())}`, W - mg, 23, { align: "right" });

  // ── Summary box ────────────────────────────────────────────────────────────
  section("Application Summary");
  doc.setDrawColor(226, 232, 240).setFillColor(248, 250, 252);
  doc.roundedRect(mg, y, cw, 30, 2, 2, "FD");
  const decision = a?.ai_decision ?? "Pending Underwriting";
  const sumPairs: [string, string][] = [
    ["Applicant", customer?.name ?? "—"],
    ["CNIC", customer?.cnic ?? "—"],
    ["Product", policy ? (INSURANCE_TYPE_LABELS[policy.insurance_type] ?? policy.product_name) : "—"],
    ["Case Status", c.caseStatus],
    ["AI Decision", decision],
    ["Application Date", fmtDate(c.createdAt)],
  ];
  const colW = cw / 3 - 2;
  for (let i = 0; i < sumPairs.length; i++) {
    const col = i % 3, rowN = Math.floor(i / 3);
    const x = mg + 5 + col * (cw / 3);
    const yy = y + 8 + rowN * 13;
    doc.setFont("helvetica", "bold").setFontSize(6.5).setTextColor(148, 163, 184);
    doc.text(sumPairs[i][0].toUpperCase(), x, yy);
    doc.setFont("helvetica", "bold").setFontSize(9).setTextColor(30, 41, 59);
    doc.text(doc.splitTextToSize(sumPairs[i][1], colW)[0] ?? "—", x, yy + 4.5);
  }
  y += 34;

  // ── Personal details ───────────────────────────────────────────────────────
  section("Personal Details");
  const addr = d.address ?? {};
  const contact = d.contact ?? {};
  const addressStr = [addr.street_address, addr.area, addr.city, addr.province, addr.postal_code]
    .filter(Boolean).join(", ");
  grid([
    { label: "Full Name", value: customer?.name ?? "—" },
    { label: "CNIC", value: customer?.cnic ?? "—" },
    { label: "Date of Birth", value: `${fmtDate(customer?.dob)} (${ageFromDob(customer?.dob)})` },
    { label: "Gender", value: customer?.gender ?? "—" },
    { label: "Marital Status", value: customer?.marital_status ?? d.marital_status ?? "—" },
    { label: "Nationality", value: d.nationality ?? "Pakistani" },
    { label: "Mobile", value: contact.mobile_number ?? "—" },
    { label: "Email", value: contact.email ?? "—" },
    { label: "Phone", value: contact.phone_number ?? "—" },
    { label: "Emergency Contact", value: contact.emergency_contact_name ? `${contact.emergency_contact_name} (${contact.emergency_contact_relation ?? "—"}) ${contact.emergency_contact_phone ?? ""}`.trim() : "—" },
    { label: "Address", value: addressStr || "—" },
    { label: "City / Province", value: [addr.city, addr.province].filter(Boolean).join(", ") || "—" },
  ]);

  // ── Plan / Policy ──────────────────────────────────────────────────────────
  section("Plan & Policy Details");
  if (policy) {
    const ratio = customer?.declared_income ? (policy.coverage_amount / customer.declared_income).toFixed(1) + "×" : "—";
    grid([
      { label: "Product", value: INSURANCE_TYPE_LABELS[policy.insurance_type] ?? policy.product_name },
      { label: "Insurance Type", value: policy.insurance_type ?? "—" },
      { label: "Sum Assured", value: fmtPKR(policy.coverage_amount) },
      { label: "Policy Term", value: policy.term_years != null ? `${policy.term_years} years` : "—" },
      { label: "Coverage-to-Income", value: ratio },
      { label: "Policy Status", value: policy.status ?? "—" },
      ...(policy.nominee_name ? [{ label: "Nominee", value: `${policy.nominee_name}${policy.nominee_relationship ? ` (${policy.nominee_relationship})` : ""}` }] : []),
      ...(policy.dependent_name ? [{ label: "Dependent", value: `${policy.dependent_name}${policy.dependent_dob ? ` — b. ${fmtDate(policy.dependent_dob)}` : ""}` }] : []),
    ]);
  } else {
    emptyNote("No policy attached to this case.");
  }

  // ── Occupation & Income ────────────────────────────────────────────────────
  section("Occupation & Income");
  const occ = d.occupation_details ?? {};
  const inc = d.income_record ?? {};
  grid([
    { label: "Occupation", value: customer?.occupation ?? "—" },
    { label: "Job Title", value: occ.job_title ?? "—" },
    { label: "Employer", value: occ.employer_name ?? "—" },
    { label: "Industry", value: occ.industry ?? "—" },
    { label: "Employment Type", value: occ.employment_type ?? "—" },
    { label: "Experience", value: occ.years_of_experience != null ? `${occ.years_of_experience} years` : "—" },
    { label: "Occupation Hazard", value: occ.occupation_hazard_level ?? d.lifestyle?.occupation_hazard_level ?? "—" },
    { label: "Work Address", value: occ.work_address ?? "—" },
    { label: "Declared Income (annual)", value: fmtPKR(customer?.declared_income) },
    { label: "Verified Income", value: fmtPKR(inc.verified_income) },
    { label: "Income Source", value: inc.income_source ?? "—" },
    { label: "Income Stability", value: inc.income_stability_score != null ? `${inc.income_stability_score}/100` : "—" },
  ]);

  // ── Medical & Lifestyle ────────────────────────────────────────────────────
  section("Medical & Lifestyle");
  const med = d.medical_history ?? {};
  const life = d.lifestyle ?? {};
  const bmi = life.bmi ?? (customer?.height_cm && customer?.weight_kg
    ? +(customer.weight_kg / Math.pow(customer.height_cm / 100, 2)).toFixed(1) : null);
  const yesno = (v: any) => (v === true ? "Yes" : v === false ? "No" : "—");
  grid([
    { label: "Smoker", value: yesno(customer?.is_smoker ?? med.is_smoker) },
    { label: "Height / Weight", value: `${customer?.height_cm ?? "—"} cm / ${customer?.weight_kg ?? "—"} kg${bmi ? ` (BMI ${bmi})` : ""}` },
    { label: "Pre-existing Conditions", value: yesno(med.has_pre_existing_conditions) },
    { label: "Diabetic", value: yesno(med.is_diabetic) },
    { label: "Hypertension", value: yesno(med.has_hypertension) },
    { label: "Heart Disease", value: yesno(med.has_heart_disease) },
    { label: "Exercise", value: life.exercise_frequency ?? "—" },
    { label: "Alcohol", value: life.alcohol_status ?? "—" },
    { label: "Surgical History", value: med.surgical_history || "None" },
  ]);
  if (med.notes) { doc.setFont("helvetica", "bold").setFontSize(6.5).setTextColor(148, 163, 184); nextPage(8); doc.text("MEDICAL NOTES", mg + 1, y); y += 4; paragraph(med.notes, 8); }

  const conditions: any[] = Array.isArray(d.conditions) ? d.conditions : [];
  if (conditions.length) {
    doc.setFont("helvetica", "bold").setFontSize(7).setTextColor(100, 116, 139); nextPage(8); doc.text("Diagnosed Conditions", mg, y); y += 4.5;
    for (const cond of conditions) {
      bullet(`${cond.condition_name ?? "Condition"} — ${cond.severity ?? "—"}${cond.diagnosis_date ? `, diagnosed ${fmtDate(cond.diagnosis_date)}` : ""}${cond.is_chronic ? " (chronic)" : ""}`);
    }
  }
  const family: any[] = Array.isArray(d.family_history) ? d.family_history : [];
  if (family.length) {
    doc.setFont("helvetica", "bold").setFontSize(7).setTextColor(100, 116, 139); nextPage(8); doc.text("Family History", mg, y); y += 4.5;
    for (const f of family) {
      bullet(`${f.relation ?? "Relative"} (${f.age ?? "—"}${f.is_alive === false ? ", deceased" : ""}) — ${f.condition_name || "None"}`);
    }
  }

  // ── Financial Profile ──────────────────────────────────────────────────────
  section("Financial Profile");
  const fin = d.financial_records ?? {};
  const bank = fin.bank_statement ?? {};
  const credit = fin.credit_bureau ?? {};
  const deps = fin.dependents ?? {};
  grid([
    { label: "Bank", value: bank.bank_name ?? "—" },
    { label: "Avg Monthly Balance", value: fmtPKR(bank.average_monthly_balance) },
    { label: "Cash-Flow Score", value: bank.cash_flow_score != null ? `${bank.cash_flow_score}/100` : "—" },
    { label: "Anomaly Flag", value: yesno(bank.anomaly_flag) },
    { label: "Credit Score", value: credit.credit_score != null ? String(credit.credit_score) : "—" },
    { label: "Credit Risk Grade", value: credit.risk_grade ?? "—" },
    { label: "Delinquencies", value: credit.delinquency_count != null ? String(credit.delinquency_count) : "—" },
    { label: "Default History", value: yesno(credit.default_history) },
    { label: "Dependents", value: deps.number_of_dependents != null ? String(deps.number_of_dependents) : "—" },
    { label: "Financial Burden", value: deps.financial_burden_score != null ? `${deps.financial_burden_score}/100` : "—" },
  ]);
  const debts: any[] = Array.isArray(fin.debts) ? fin.debts : [];
  if (debts.length) {
    doc.setFont("helvetica", "bold").setFontSize(7).setTextColor(100, 116, 139); nextPage(8); doc.text("Outstanding Debts", mg, y); y += 4.5;
    for (const db of debts) {
      bullet(`${db.debt_type ?? "Debt"} — ${fmtPKR(db.outstanding_amount)} outstanding${db.monthly_emi ? `, EMI ${fmtPKR(db.monthly_emi)}` : ""}`);
    }
  }

  // ── Beneficiary / Nominee ──────────────────────────────────────────────────
  section("Beneficiary / Nominee");
  const ben = d.beneficiary ?? {};
  const benName = [ben.first_name, ben.last_name].filter(Boolean).join(" ");
  if (benName || policy?.nominee_name) {
    grid([
      { label: "Name", value: benName || policy?.nominee_name || "—" },
      { label: "Relationship", value: ben.relationship || policy?.nominee_relationship || "—" },
      { label: "Share", value: ben.share_percentage != null ? `${ben.share_percentage}%` : "—" },
      { label: "CNIC", value: ben.cnic_number || "—" },
      { label: "Date of Birth", value: fmtDate(ben.date_of_birth) },
      { label: "Contact", value: ben.phone || ben.email || "—" },
      ...(ben.is_minor ? [{ label: "Guardian", value: `${ben.guardian_name ?? "—"}${ben.guardian_cnic ? ` (${ben.guardian_cnic})` : ""}` }] : []),
    ]);
  } else {
    emptyNote("No nominee recorded.");
  }

  // ── Brought By ─────────────────────────────────────────────────────────────
  if (customer?.acquisition_source) {
    section("Brought By");
    const s = customer.acquisition_source;
    grid([
      { label: "Source", value: s.name ?? "—" },
      { label: "Channel", value: SOURCE_TYPE_LABELS[s.source_type] ?? s.source_type ?? "—" },
      ...(s.partner_name ? [{ label: "Partner", value: s.partner_name }] : []),
      { label: "Producer Code", value: s.code ?? "—" },
    ]);
  }

  // ── Documents ──────────────────────────────────────────────────────────────
  section("Documents Checklist");
  if (docs && docs.required.length) {
    for (const req of docs.required) {
      const got = docs.received.includes(req);
      nextPage(6);
      doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(71, 85, 105);
      doc.text(req, mg + 5, y);
      doc.setFont("helvetica", "bold").setFontSize(8);
      if (got) doc.setTextColor(16, 185, 129); else doc.setTextColor(245, 158, 11);
      doc.text(got ? "RECEIVED" : "MISSING", W - mg, y, { align: "right" });
      doc.setFillColor(got ? 16 : 245, got ? 185 : 158, got ? 129 : 11);
      doc.circle(mg + 1.5, y - 1, 0.9, "F");
      y += 5.2;
    }
    y += 2;
  } else {
    emptyNote("No documents required for this plan type.");
  }

  // ── Underwriting Result ────────────────────────────────────────────────────
  section("Underwriting Result");
  if (a) {
    nextPage(16);
    const composite = a.composite_risk_score ?? null;
    const band: [number, number, number] = composite != null ? scoreColorRGB(composite) : [59, 130, 246];
    const lum = 0.299 * band[0] + 0.587 * band[1] + 0.114 * band[2];
    const tc = lum > 150 ? [15, 23, 42] : [255, 255, 255];
    doc.setFillColor(...band).roundedRect(mg, y, cw, 12, 2, 2, "F");
    doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(tc[0], tc[1], tc[2]);
    doc.text(`DECISION: ${String(a.ai_decision).toUpperCase()}`, mg + 6, y + 7.5);
    if (composite != null) doc.text(`COMPOSITE RISK: ${composite} / 100`, W - mg - 6, y + 7.5, { align: "right" });
    y += 18;

    const items = [
      { label: "Medical Risk", value: `${a.medical_score ?? "—"}%` },
      { label: "Financial Risk", value: `${a.financial_score ?? "—"}%` },
      { label: "Fraud Risk", value: `${a.fraud_probability != null ? Math.round(a.fraud_probability * 100) : "—"}%` },
    ];
    if (a.suggested_loading != null) items.push({ label: "Loading", value: `+${a.suggested_loading}%` });
    const gap = 4, boxW = (cw - gap * (items.length - 1)) / items.length;
    nextPage(20);
    for (let i = 0; i < items.length; i++) {
      const x = mg + i * (boxW + gap);
      doc.setDrawColor(226, 232, 240).setFillColor(255, 255, 255).roundedRect(x, y, boxW, 16, 2, 2, "FD");
      doc.setFont("helvetica", "bold").setFontSize(7).setTextColor(148, 163, 184);
      doc.text(items[i].label.toUpperCase(), x + boxW / 2, y + 6, { align: "center" });
      doc.setFont("helvetica", "bold").setFontSize(12).setTextColor(30, 41, 59);
      doc.text(items[i].value, x + boxW / 2, y + 12.5, { align: "center" });
    }
    y += 22;

    const reasons: string[] = a.reasons ?? [
      ...(a.medical_reasons ?? []), ...(a.financial_reasons ?? []), ...(a.fraud_reasons ?? []),
    ];
    // Drop the composite-score / decision math breakdown line — it's internal
    // aggregation arithmetic, not an underwriting risk factor.
    const visibleReasons = reasons.filter(
      (r) => !(r.includes("->") || r.includes("!'") || r.toLowerCase().includes("composite score")),
    );
    if (visibleReasons.length) {
      doc.setFont("helvetica", "bold").setFontSize(7).setTextColor(100, 116, 139); nextPage(8); doc.text("Key Risk Factors", mg, y); y += 4.5;
      for (const r of visibleReasons) bullet(r);
    }
    if (a.ai_summary) { section("AI Case Summary"); paragraph(String(a.ai_summary).replace(/[#*]/g, ""), 8.5); }
  } else {
    emptyNote("This case has not been underwritten yet — run AI underwriting to complete the application.");
  }

  // ── Footer ─────────────────────────────────────────────────────────────────
  const total = (doc as unknown as { internal: { getNumberOfPages(): number } }).internal.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal").setFontSize(7).setTextColor(150, 160, 175);
    doc.text("insurance-ai · Confidential Application Document", mg, 292);
    doc.text(`Page ${p} of ${total}`, W - mg - 18, 292);
  }

  const safeName = (customer?.name ?? "applicant").replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  doc.save(`application_${safeName}_${new Date().toISOString().slice(0, 10)}.pdf`);
}
