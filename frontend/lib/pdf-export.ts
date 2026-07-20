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
  if (score <= 10) return [16, 185, 129]; // emerald-500
  if (score <= 20) return [52, 211, 153]; // emerald-400
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

export async function generateAssessmentPDF(detail: PDFReportData) {
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
  doc.text("UNDERWRITING REPORT", W - mg, 14, { align: "right" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  doc.text("Risk Assessment & AI Analysis", W - mg, 20, { align: "right" });
  
  doc.setTextColor(148, 163, 184);
  doc.text(`Generated: ${fmt(new Date().toISOString())}`, W - mg, 24, { align: "right" });

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

  // Footer on every page
  const total = (doc as unknown as { internal: { getNumberOfPages(): number } }).internal.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7).setTextColor(150, 160, 175);
    doc.text("insurance-ai · Confidential", mg, 292);
    doc.text(`Page ${p} of ${total}`, W - mg - 18, 292);
  }

  doc.save(`assessment_${detail.customer_cnic}_${new Date().toISOString().slice(0, 10)}.pdf`);
}
