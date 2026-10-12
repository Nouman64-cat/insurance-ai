import type { AIDecision } from "@/lib/mock-data";

export interface PDFReportData {
  customer_name: string;
  customer_cnic: string;
  case_id: string | null;
  created_at: string;
  medical_score: number;
  financial_score: number;
  fraud_probability: number;
  composite_risk_score: number | null;
  ai_decision: string;
  suggested_loading: number | null;
  reasons: any[];
  ai_summary: string | null;
  product_name?: string | null;
}

function getScoreColorRGB(score: number): [number, number, number] {
  if (score <= 10) return [16, 185, 129]; // blue-500
  if (score <= 20) return [52, 211, 153]; // blue-400
  if (score <= 30) return [163, 230, 53]; // lime-400
  if (score <= 40) return [250, 204, 21]; // yellow-400
  if (score <= 50) return [251, 191, 36]; // amber-400
  if (score <= 60) return [245, 158, 11]; // amber-500
  if (score <= 70) return [249, 115, 22]; // orange-500
  if (score <= 80) return [248, 113, 113]; // red-400
  if (score <= 90) return [239, 68, 68];  // red-500
  return [220, 38, 38];                   // red-600
}

function fmt(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-PK", { day: "2-digit", month: "short", year: "numeric" })
    + " · " + d.toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" });
}

/** Who one section of a report is about. `detail` is null for an insured member who has not been assessed yet. */
export interface ReportEntry {
  detail: PDFReportData | null;
  name: string;
  /** Shown above the section on a family report, e.g. "Spouse". */
  role?: string;
  /** What the assessment means for this person's cover. */
  outcome?: "Approved" | "Needs review" | "Rejected" | "Not assessed";
}

export interface ReportSummaryRow { name: string; role: string; medical?: number; financial?: number; fraud?: number; composite?: number | null; decision: string; outcome: string }

export interface ReportOptions {
  title?: string;
  subtitle?: string;
  filename?: string;
  /** A family report opens with a summary page: one row per insured member, the verdict on the policy, and the nominees. */
  summary?: { heading: string; policy_label?: string | null; rows: ReportSummaryRow[]; verdict: string; nominees: { name: string; relationship: string; share_pct: number; amount: number | null }[] };
}

const OUTCOME_COLOR: Record<string, [number, number, number]> = {
  "Approved": [16, 185, 129], "Needs review": [245, 158, 11], "Rejected": [220, 38, 38], "Not assessed": [148, 163, 184],
};
const OUTCOME_TEXT: Record<string, string> = {
  "Approved": "Approved for full insurance",
  "Needs review": "Needs an underwriter's review",
  "Rejected": "Not approved for full insurance",
  "Not assessed": "Not assessed yet",
};

export async function generateAssessmentPDF(detail: PDFReportData) {
  await generateAssessmentReport([{ detail, name: detail.customer_name }]);
}

/** One document, one full assessment section per person. A single entry is the ordinary underwriting report. */
export async function generateAssessmentReport(entries: ReportEntry[], opts: ReportOptions = {}) {
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

  const nextPage = (needed: number) => {
    if (y + needed > 280) { doc.addPage(); y = mg; }
  };

  const section = (label: string) => {
    nextPage(18);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(59, 130, 246); // Nice blue accent for section headers
    doc.text(label.toUpperCase(), mg, y);
    y += 6;
  };

  const row = (label: string, value: string, xPos: number, yPos: number) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    doc.setTextColor(148, 163, 184); // slate-400
    doc.text(label.toUpperCase(), xPos, yPos);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(30, 41, 59); // slate-800
    doc.text(value, xPos, yPos + 4.5);
  };

  // Header band with logo
  doc.setFillColor(255, 255, 255);
  doc.rect(0, 0, W, 28, "F");
  
  // A subtle gradient-like or accent line at the bottom of header
  doc.setFillColor(241, 245, 249); // slate-100
  doc.rect(0, 28, W, 1.5, "F");
  doc.setFillColor(59, 130, 246); // blue-500
  doc.rect(0, 28, W / 3, 1.5, "F");

  // Logo on Top Left (vertically centered in 28px header)
  if (logoImg) {
    doc.addImage(logoImg, "PNG", mg, 7.5, 36.2, 13);
  }

  // Titles on Top Right
  doc.setTextColor(15, 23, 42);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text((opts.title ?? "UNDERWRITING REPORT").toUpperCase(), W - mg, 14, { align: "right" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  doc.text(opts.subtitle ?? "Risk Assessment & AI Analysis", W - mg, 20, { align: "right" });
  
  doc.setTextColor(148, 163, 184);
  doc.text(`Generated: ${fmt(new Date().toISOString())}`, W - mg, 24, { align: "right" });

  const renderEntry = (entry: ReportEntry, index: number) => {
    const detail = entry.detail;
    if (opts.summary) {
      // A family report: every insured person starts on their own page, under a banner naming them and what it means for their cover.
      doc.addPage(); y = mg + 4;
      const outcome = entry.outcome ?? "Not assessed";
      const [r, g, b] = OUTCOME_COLOR[outcome];
      doc.setFillColor(r, g, b).roundedRect(mg, y, cw, 10, 2, 2, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(9.5);
      doc.setTextColor(outcome === "Needs review" ? 15 : 255, outcome === "Needs review" ? 23 : 255, outcome === "Needs review" ? 42 : 255);
      doc.text(`INSURED MEMBER ${index + 1} · ${(entry.role ?? "").toUpperCase()} · ${entry.name.toUpperCase()}`, mg + 5, y + 6.4);
      doc.text(OUTCOME_TEXT[outcome].toUpperCase(), W - mg - 5, y + 6.4, { align: "right" });
      y += 16;
    }
    if (!detail) {
      section("Risk assessment");
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(71, 85, 105);
      doc.text(`${entry.name} has not been assessed yet — run the risk assessment to see their scores here.`, mg, y);
      y += 8;
      return;
    }
    // Customer block (2-column layout in a light box)
    section("Applicant Details");
    doc.setDrawColor(226, 232, 240); // slate-200
    doc.setFillColor(248, 250, 252); // slate-50
    doc.roundedRect(mg, y, cw, 38, 2, 2, "FD");
  
    row("Name", detail.customer_name, mg + 5, y + 8);
    row("CNIC", detail.customer_cnic, mg + (cw / 2) + 5, y + 8);

    if (detail.case_id) {
      row("Case ID", detail.case_id, mg + 5, y + 18);
    }
    if (detail.product_name) {
      row("Product", detail.product_name, mg + (cw / 2) + 5, y + 18);
    }
  
    row("Assessed On", fmt(detail.created_at), mg + 5, y + 28);
  
    y += 42;

    // Decision band
    nextPage(16);
    const decision = detail.ai_decision;
    const composite = detail.composite_risk_score;
    const bandColor: [number, number, number] = composite !== null ? getScoreColorRGB(composite) : [59, 130, 246]; // use risk score color, fallback to blue
    
    const [bR, bG, bB] = bandColor;
    const luminance = 0.299 * bR + 0.587 * bG + 0.114 * bB;
    const textColor = luminance > 150 ? [15, 23, 42] : [255, 255, 255]; // dark slate for light bars, white for dark bars
    
    doc.setFillColor(...bandColor).roundedRect(mg, y, cw, 12, 2, 2, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11).setTextColor(textColor[0], textColor[1], textColor[2]);
    doc.text(`DECISION: ${decision.toUpperCase()}`, mg + 6, y + 7.5);
    if (composite !== null) {
      doc.text(`COMPOSITE RISK: ${composite} / 100`, W - mg - 6, y + 7.5, { align: "right" });
    }
    y += 18;

    // Scores (Grid of mini-cards)
    section("Risk Scores");
  
    const scoreItems = [
      { label: "Medical Risk", value: `${detail.medical_score}%` },
      { label: "Financial Risk", value: `${detail.financial_score}%` },
      { label: "Fraud Risk", value: `${Math.round(detail.fraud_probability * 100)}%` },
    ];
    if (detail.suggested_loading != null) {
      scoreItems.push({ label: "Loading", value: `+${detail.suggested_loading}%` });
    }
  
    const cols = scoreItems.length;
    const gap = 4;
    const boxW = (cw - (gap * (cols - 1))) / cols;
  
    for (let i = 0; i < scoreItems.length; i++) {
      const x = mg + (i * (boxW + gap));
      doc.setDrawColor(226, 232, 240); // slate-200
      doc.setFillColor(255, 255, 255);
      doc.roundedRect(x, y, boxW, 16, 2, 2, "FD");
    
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7);
      doc.setTextColor(148, 163, 184); // slate-400
      doc.text(scoreItems[i].label.toUpperCase(), x + (boxW/2), y + 6, { align: "center" });
    
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.setTextColor(30, 41, 59);
      doc.text(scoreItems[i].value, x + (boxW/2), y + 12.5, { align: "center" });
    }
  
    y += 22;

    // Reasons — drop the composite-score / decision math breakdown line; it's
    // internal aggregation arithmetic, not an underwriting risk factor.
    const visibleReasons = (detail.reasons ?? []).filter(
      (r) => {
        const text = (typeof r === "object" && r !== null) ? (r.observation || r.reason || "") : (r as string);
        return !(text.includes("->") || text.includes("!'") || text.toLowerCase().includes("composite score"));
      }
    );
    if (visibleReasons.length > 0) {
      section("Key Risk Factors");

      for (let i = 0; i < visibleReasons.length; i++) {
        const reasonObj = visibleReasons[i];
        const isObj = typeof reasonObj === "object" && reasonObj !== null;
        const reasonText = isObj ? (reasonObj.observation || reasonObj.reason || "") : (reasonObj as string);
        const isLast = i === visibleReasons.length - 1;

        const isMathBreakdown = isLast && (reasonText.includes("->") || reasonText.includes("!'") || reasonText.toLowerCase().includes("composite score"));

        if (isMathBreakdown) {
          const normalized = reasonText
            .replace(/×/g, "x")
            .replace(/→/g, "->")
            .replace(/!'/g, "->")
            .replace(/–/g, "-")
            .replace(/</g, "under")
            .replace(/>/g, "over");
        
          const parts = normalized.split("->").map((p: string) => p.trim());
          const calc = parts[0] || "";
          const rule = parts.slice(1).join(" -> ");

          doc.setFont("helvetica", "normal");
          doc.setFontSize(8);
          const calcWrapped = doc.splitTextToSize(calc, cw - 8);
          const ruleWrapped = rule ? doc.splitTextToSize(rule, cw - 8) : [];
        
          let simCy = 8; // Top padding (baseline is approx 3 units above bottom of text bounding box, so 8 gives ~5 units of visual top padding)
          simCy += 4; // Title 1 height
          simCy += calcWrapped.length * 4; // calc lines
          if (rule) {
            simCy += 2; // gap
            simCy += 4; // Title 2 height
            simCy += ruleWrapped.length * 4; // rule lines
          }
          const boxH = simCy + 2; // Add bottom padding

          y += 2;
          nextPage(boxH + 4);
        
          // Draw calculation callout box
          doc.setDrawColor(226, 232, 240); // slate-200
          doc.setFillColor(248, 250, 252); // slate-50
          doc.roundedRect(mg, y, cw, boxH, 2, 2, "FD");
        
          let cy = y + 8;
          doc.setFont("helvetica", "bold");
          doc.setFontSize(8);
          doc.setTextColor(71, 85, 105);
          doc.text("MATH BREAKDOWN", mg + 4, cy);
          cy += 4;
        
          doc.setFont("helvetica", "normal");
          doc.setFontSize(8);
          doc.setTextColor(30, 41, 59);
          for (const line of calcWrapped) {
            doc.text(line, mg + 4, cy);
            cy += 4;
          }
        
          if (rule) {
            cy += 2;
            doc.setFont("helvetica", "bold");
            doc.setFontSize(8);
            doc.setTextColor(71, 85, 105);
            doc.text("MATCHED RULE", mg + 4, cy);
            cy += 4;
          
            doc.setFont("helvetica", "normal");
            doc.setFontSize(8);
            doc.setTextColor(30, 41, 59);
            for (const line of ruleWrapped) {
              doc.text(line, mg + 4, cy);
              cy += 4;
            }
          }
        
          y += boxH + 4;
        } else {
          // Normal reason drawing with dot
          doc.setFont("helvetica", "normal");
          doc.setFontSize(8.5);
          doc.setTextColor(71, 85, 105);
        
          const displayStr = isObj ? `${reasonObj.parameter || reasonObj.factor}: ${reasonObj.observation || reasonObj.reason}` : reasonText;
          const wrapped = doc.splitTextToSize(displayStr, cw - 5);
          nextPage(wrapped.length * 4.5);
        
          const riskRating = isObj ? (reasonObj.risk_rating || reasonObj.risk_level) : "Low";
          const isHighOrMod = isObj && (riskRating.toLowerCase().includes("high") || riskRating.toLowerCase().includes("moderate"));
          doc.setFillColor(isHighOrMod ? 245 : 59, isHighOrMod ? 158 : 130, isHighOrMod ? 11 : 246); // amber-500 or blue-500
          doc.circle(mg + 1.5, y - 1, 0.8, "F");
        
          for (const line of wrapped) {
            doc.text(line, mg + 4, y);
            y += 4.5;
          }
          y += 1.5;
        }
      }
      y += 4;
    }

    // AI Summary
    if (detail.ai_summary) {
      section("AI CASE SUMMARY");
      const lines = detail.ai_summary.split("\n");
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (!line) {
          y += 3;
          continue;
        }

        // Header 6
        if (line.startsWith("###### ")) {
          const text = line.replace("###### ", "").trim();
          nextPage(8);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(8);
          doc.setTextColor(100, 116, 139);
          doc.text(text, mg, y);
          y += 4;
          continue;
        }

        // Header 5
        if (line.startsWith("##### ")) {
          const text = line.replace("##### ", "").trim();
          nextPage(8);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(8.5);
          doc.setTextColor(100, 116, 139);
          doc.text(text, mg, y);
          y += 4.5;
          continue;
        }

        // Header 4
        if (line.startsWith("#### ")) {
          const text = line.replace("#### ", "").trim();
          nextPage(8);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(9);
          doc.setTextColor(71, 85, 105);
          doc.text(text, mg, y);
          y += 4.5;
          continue;
        }

        // Header 3
        if (line.startsWith("### ")) {
          const text = line.replace("### ", "").trim();
          nextPage(8);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(9.5);
          doc.setTextColor(71, 85, 105);
          doc.text(text, mg, y);
          y += 5;
          continue;
        }

        // Header 2
        if (line.startsWith("## ")) {
          const text = line.replace("## ", "").trim();
          nextPage(10);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(10);
          doc.setTextColor(30, 41, 59);
          doc.text(text, mg, y);
          y += 5.5;
          continue;
        }

        // Header 1
        if (line.startsWith("# ")) {
          const text = line.replace("# ", "").trim();
          nextPage(12);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(11);
          doc.setTextColor(15, 23, 42);
          doc.text(text, mg, y);
          y += 6;
          continue;
        }

        // Bullet list
        if (line.startsWith("- ") || line.startsWith("* ") || line.startsWith("• ")) {
          const text = line.replace(/^[-*•]\s+/, "").trim();
          const cleanText = text.replace(/\*\*/g, "").replace(/\*/g, "");
          const wrapped = doc.splitTextToSize(cleanText, cw - 6);
          nextPage(wrapped.length * 4.5 + 2);
          doc.setFont("helvetica", "normal");
          doc.setFontSize(8.5);
          doc.setTextColor(71, 85, 105);
        
          doc.text("•", mg + 2, y);
          for (let j = 0; j < wrapped.length; j++) {
            doc.text(wrapped[j], mg + 6, y);
            y += 4.5;
          }
          continue;
        }

        // Regular paragraph line
        const cleanLine = line.replace(/\*\*/g, "").replace(/\*/g, "");
        const wrapped = doc.splitTextToSize(cleanLine, cw);
        nextPage(wrapped.length * 4.5 + 2);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8.5);
        doc.setTextColor(71, 85, 105);
        for (let j = 0; j < wrapped.length; j++) {
          doc.text(wrapped[j], mg, y);
          y += 4.5;
        }
      }
    }

  };

  if (opts.summary) {
    const sm = opts.summary;
    section(sm.heading);
    if (sm.policy_label) { doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(100, 116, 139); doc.text(sm.policy_label, mg, y); y += 6; }
    // Table: one row per insured member, each with their own three risks and verdict.
    const cols = [
      { h: "MEMBER", x: mg, w: 46 }, { h: "ROLE", x: mg + 46, w: 20 }, { h: "MEDICAL", x: mg + 66, w: 20 },
      { h: "FINANCIAL", x: mg + 86, w: 22 }, { h: "FRAUD", x: mg + 108, w: 18 }, { h: "DECISION", x: mg + 126, w: 28 }, { h: "OUTCOME", x: mg + 154, w: cw - 154 },
    ];
    doc.setFillColor(241, 245, 249).rect(mg, y - 4, cw, 7, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(6.8); doc.setTextColor(100, 116, 139);
    cols.forEach((c) => doc.text(c.h, c.x + 1.5, y));
    y += 6;
    for (const r of sm.rows) {
      nextPage(14);
      const [cr, cg, cb] = OUTCOME_COLOR[r.outcome] ?? OUTCOME_COLOR["Not assessed"];
      doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(30, 41, 59);
      doc.text(doc.splitTextToSize(r.name, 44)[0], cols[0].x + 1.5, y);
      doc.setFont("helvetica", "normal"); doc.setTextColor(71, 85, 105);
      doc.text(r.role, cols[1].x + 1.5, y);
      doc.text(r.medical != null ? `${r.medical}%` : "—", cols[2].x + 1.5, y);
      doc.text(r.financial != null ? `${r.financial}%` : "—", cols[3].x + 1.5, y);
      doc.text(r.fraud != null ? `${Math.round(r.fraud * 100)}%` : "—", cols[4].x + 1.5, y);
      doc.text(doc.splitTextToSize(r.decision, 26)[0], cols[5].x + 1.5, y);
      doc.setFillColor(cr, cg, cb).circle(cols[6].x + 2.5, y - 1.2, 1.3, "F");
      doc.setFont("helvetica", "bold"); doc.setTextColor(cr === 245 ? 146 : cr, cr === 245 ? 64 : cg, cr === 245 ? 14 : cb);
      doc.text(r.outcome, cols[6].x + 6, y);
      doc.setDrawColor(241, 245, 249).line(mg, y + 3, mg + cw, y + 3);
      y += 8;
    }
    y += 4;
    // The verdict on the policy as a whole
    const vlines = doc.splitTextToSize(sm.verdict, cw - 10) as string[];
    nextPage(vlines.length * 4.6 + 12);
    doc.setDrawColor(226, 232, 240).setFillColor(248, 250, 252).roundedRect(mg, y, cw, vlines.length * 4.6 + 10, 2, 2, "FD");
    doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(100, 116, 139); doc.text("POLICY OUTCOME", mg + 5, y + 5.5);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(30, 41, 59);
    vlines.forEach((ln, i) => doc.text(ln, mg + 5, y + 10.5 + i * 4.6));
    y += vlines.length * 4.6 + 16;
    if (sm.nominees.length) {
      section("Nominees — share of the head's death benefit");
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(100, 116, 139);
      doc.text("Nominees carry no cover and are not underwritten.", mg, y); y += 6;
      for (const n of sm.nominees) {
        nextPage(7);
        doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(30, 41, 59); doc.text(n.name, mg, y);
        doc.setFont("helvetica", "normal"); doc.setTextColor(100, 116, 139);
        doc.text(n.relationship, mg + 70, y); doc.text(`${n.share_pct}%`, W - mg - 45, y, { align: "right" });
        doc.text(n.amount != null ? `PKR ${Math.round(n.amount).toLocaleString()}` : "—", W - mg, y, { align: "right" });
        y += 6;
      }
    }
  }

  entries.forEach(renderEntry);

  // Footer on every page
  const total = (doc as unknown as { internal: { getNumberOfPages(): number } }).internal.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7).setTextColor(150, 160, 175);
    doc.text("insurance-ai · Confidential", mg, 292);
    doc.text(`Page ${p} of ${total}`, W - mg - 18, 292);
  }

  const day = new Date().toISOString().slice(0, 10);
  doc.save(opts.filename ?? `assessment_${entries[0]?.detail?.customer_cnic ?? "report"}_${day}.pdf`);
}



// ── Family report ────────────────────────────────────────────────────────────────────────────────────────────────
// A family policy covers the head and, if chosen, a fully insured spouse — each underwritten on their own, so each gets
// their own full section here (scores, key risk factors, summary) and their own verdict. The policy can go ahead for the
// head even when the spouse is not approved; the summary page says so.

export interface FamilyReportMember {
  role: string;                                   // "Head" | "Spouse"
  name: string;
  status: "Approved" | "Needs review" | "Rejected" | "Not assessed";
  report: PDFReportData | null;
}

export interface FamilyReportData {
  family_name: string;
  policy_label?: string | null;
  members: FamilyReportMember[];
  nominees: { name: string; relationship: string; share_pct: number; amount: number | null }[];
}

export function familyVerdict(members: FamilyReportMember[]): string {
  const head = members.find((m) => m.role === "Head") ?? members[0];
  const others = members.filter((m) => m !== head);
  const names = (list: FamilyReportMember[]) => list.map((m) => m.name).join(" and ");
  const bad = others.filter((m) => m.status === "Rejected");
  const open = others.filter((m) => m.status === "Needs review" || m.status === "Not assessed");
  if (head.status === "Rejected") return `${head.name} (head) is not approved, so the family policy cannot go ahead.`;
  if (head.status !== "Approved") return `${head.name} (head) still needs an underwriter's decision before the family policy can go ahead.`;
  const parts = [`The policy can go ahead for the head, ${head.name}.`];
  const ok = others.filter((m) => m.status === "Approved");
  if (ok.length) parts.push(`${names(ok)} ${ok.length === 1 ? "is" : "are"} approved for full insurance as well.`);
  if (bad.length) parts.push(`${names(bad)} ${bad.length === 1 ? "is" : "are"} not approved for full insurance and can stay on the policy as ${bad.length === 1 ? "a nominee" : "nominees"} only.`);
  if (open.length) parts.push(`${names(open)} ${open.length === 1 ? "needs" : "need"} an underwriter's review (or an assessment) before full insurance is decided.`);
  return parts.join(" ");
}

export async function generateFamilyAssessmentPDF(data: FamilyReportData) {
  // The head's section first, then each insured spouse, whatever order they were underwritten in.
  const ordered = [...data.members].sort((a, b) => Number(b.role === "Head") - Number(a.role === "Head"));
  await generateAssessmentReport(
    ordered.map((m) => ({ detail: m.report, name: m.name, role: m.role, outcome: m.status })),
    {
      title: "Family underwriting report",
      subtitle: "Risk assessment & AI analysis — each insured member separately",
      filename: `family-underwriting-${data.family_name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pdf`,
      summary: {
        heading: `Family policy — ${data.family_name}`,
        policy_label: data.policy_label,
        rows: ordered.map((m) => ({
          name: m.name, role: m.role, medical: m.report?.medical_score, financial: m.report?.financial_score, fraud: m.report?.fraud_probability,
          composite: m.report?.composite_risk_score, decision: m.report?.ai_decision ?? "—", outcome: m.status,
        })),
        verdict: familyVerdict(ordered),
        nominees: data.nominees,
      },
    }
  );
}
