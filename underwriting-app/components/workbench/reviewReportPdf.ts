import { getMedicalExam, type MedicalExamOrder } from "@/app/services/medicalExam";

/** What the report needs from the open review (a subset of the workspace). */
export type ReviewReportInput = {
  track: "medical" | "financial";
  reference: string;
  customerName: string;
  customerCnic: string | null;
  productName: string | null;
  coverageAmount: number | null;
  termYears: number | null;
  reviewStatus: string;
  reviewer: string | null;
  decidedAt: string | null;
  note: string | null;
  evidence: Record<string, unknown>;
  assessment: { score: number; reasons: unknown[] } | null;
  documents: { name: string; type: string; status: string }[];
};

const BLUE: [number, number, number] = [37, 99, 235];
const INK: [number, number, number] = [15, 23, 42];
const MUTED: [number, number, number] = [100, 116, 139];
const RULE: [number, number, number] = [226, 232, 240];
const WASH: [number, number, number] = [248, 250, 252];
const TONE: Record<string, [number, number, number]> = {
  CLEARED: [5, 150, 105], REFERRED: [217, 119, 6], DECLINED: [225, 29, 72],
};
const STATUS_TEXT: Record<string, string> = { PENDING: "Not started", IN_REVIEW: "In review", CLEARED: "Cleared", REFERRED: "Referred", DECLINED: "Declined" };

const text = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.length ? v.map(text).join(", ") : "—";
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k.replace(/_/g, " ")}: ${text(x)}`).join("; ");
  return String(v);
};
const money = (n: number | null) => (n == null ? "—" : `PKR ${Math.round(n).toLocaleString("en-US")}`);
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");

async function logo(): Promise<{ data: string; w: number; h: number } | null> {
  try {
    const blob = await (await fetch("/rizvi.png")).blob();
    const data: string = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = no; r.readAsDataURL(blob); });
    const size: { w: number; h: number } = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok({ w: i.width, h: i.height }); i.onerror = no; i.src = data; });
    return { data, ...size };
  } catch { return null; }
}

/** Builds and saves the specialist review report as an A4 PDF. */
export async function downloadReviewReport(input: ReviewReportInput, caseId: string): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const medical = input.track === "medical";
  const exam: MedicalExamOrder | null = medical ? await getMedicalExam(caseId).catch(() => null) : null;
  const mark = await logo();
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210, M = 16, CW = W - M * 2, BOTTOM = 276;
  let y = 0;

  const setInk = (c: [number, number, number]) => pdf.setTextColor(c[0], c[1], c[2]);
  const header = () => {
    if (mark) { const h = 11, w = (mark.w / mark.h) * h; pdf.addImage(mark.data, "PNG", M, 11, w, h); }
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(13); setInk(INK);
    pdf.text(medical ? "Medical Underwriting Report" : "Financial Underwriting Report", W - M, 15.5, { align: "right" });
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(8.5); setInk(MUTED);
    pdf.text(`Application ${input.reference}`, W - M, 20.5, { align: "right" });
    pdf.setDrawColor(BLUE[0], BLUE[1], BLUE[2]); pdf.setLineWidth(0.6); pdf.line(M, 26, W - M, 26);
    y = 34;
  };
  const room = (h: number) => { if (y + h > BOTTOM) { pdf.addPage(); header(); } };
  const section = (title: string) => {
    room(16);
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(9); setInk(BLUE);
    pdf.text(title.toUpperCase(), M, y);
    pdf.setDrawColor(RULE[0], RULE[1], RULE[2]); pdf.setLineWidth(0.3); pdf.line(M, y + 2, W - M, y + 2);
    y += 8;
  };
  /** Label / value pairs laid out in `cols` columns. */
  const facts = (rows: [string, string][], cols = 3) => {
    const colW = CW / cols;
    for (let i = 0; i < rows.length; i += cols) {
      const slice = rows.slice(i, i + cols);
      const lines = slice.map(([, v]) => pdf.splitTextToSize(v, colW - 4) as string[]);
      const h = 4.5 + Math.max(...lines.map((l) => l.length)) * 4.6 + 2.5;
      room(h);
      slice.forEach(([k], c) => {
        const x = M + c * colW;
        pdf.setFont("helvetica", "normal"); pdf.setFontSize(7.5); setInk(MUTED); pdf.text(k.toUpperCase(), x, y);
        pdf.setFont("helvetica", "bold"); pdf.setFontSize(9.5); setInk(INK); pdf.text(lines[c], x, y + 4.6);
      });
      y += h;
    }
    y += 2;
  };
  /** A real table: header row, zebra rows, columns that never overlap. */
  const table = (head: string[], widths: number[], rows: string[][], flag?: (row: string[]) => [number, number, number] | null) => {
    const draw = (cells: string[], bold: boolean, fill?: [number, number, number], colourAt?: [number, number, number] | null) => {
      const wrapped = cells.map((c, i) => pdf.splitTextToSize(c, widths[i] - 4) as string[]);
      const h = Math.max(...wrapped.map((l) => l.length)) * 4.4 + 3.6;
      room(h);
      if (fill) { pdf.setFillColor(fill[0], fill[1], fill[2]); pdf.rect(M, y - 4.2, CW, h, "F"); }
      let x = M;
      wrapped.forEach((lines, i) => {
        pdf.setFont("helvetica", bold ? "bold" : "normal"); pdf.setFontSize(bold ? 7.5 : 8.8);
        setInk(bold ? MUTED : colourAt && i === cells.length - 1 ? colourAt : INK);
        pdf.text(bold ? lines.map((l) => l.toUpperCase()) : lines, x + 2, y);
        x += widths[i];
      });
      y += h;
      pdf.setDrawColor(RULE[0], RULE[1], RULE[2]); pdf.setLineWidth(0.2); pdf.line(M, y - 4.2, W - M, y - 4.2);
    };
    draw(head, true, WASH);
    rows.forEach((r) => draw(r, false, undefined, flag?.(r) ?? null));
    y += 3;
  };
  const paragraph = (body: string, size = 9.5) => {
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(size); setInk(INK);
    for (const line of pdf.splitTextToSize(body, CW) as string[]) { room(5.5); pdf.text(line, M, y); y += 4.9; }
    y += 2;
  };

  header();

  // ── Decision banner ──
  const tone = TONE[input.reviewStatus] ?? MUTED;
  pdf.setFillColor(WASH[0], WASH[1], WASH[2]); pdf.roundedRect(M, y - 4, CW, 22, 2, 2, "F");
  pdf.setFillColor(tone[0], tone[1], tone[2]); pdf.roundedRect(M, y - 4, 2.2, 22, 1, 1, "F");
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(7.5); setInk(MUTED); pdf.text("REVIEW DECISION", M + 7, y + 1);
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(16); setInk(tone); pdf.text(STATUS_TEXT[input.reviewStatus] ?? input.reviewStatus, M + 7, y + 10);
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(8.5); setInk(MUTED);
  pdf.text(`Reviewed by ${input.reviewer ?? "—"}`, W - M - 4, y + 2, { align: "right" });
  pdf.text(`Date ${when(input.decidedAt)}`, W - M - 4, y + 8, { align: "right" });
  if (medical && exam?.outcome) pdf.text(`Clinical outcome: ${exam.outcome.replace(/([a-z])([A-Z])/g, "$1 $2")}${exam.suggested_loading_pct ? ` · +${exam.suggested_loading_pct}% loading` : ""}`, W - M - 4, y + 14, { align: "right" });
  y += 28;

  // ── Applicant & policy ──
  section("Applicant & policy");
  facts([
    ["Applicant", input.customerName], ["CNIC", input.customerCnic ?? "—"], ["Application no.", input.reference],
    ["Plan", input.productName ?? "—"], ["Sum assured", money(input.coverageAmount)], ["Term", input.termYears ? `${input.termYears} years` : "—"],
  ]);

  if (medical) {
    const e = input.evidence;
    section("Medical profile");
    facts([
      ["Date of birth", text(e["Date of birth"])], ["Smoker", text(e["Smoker"])], ["Height / weight", `${text(e["Height (cm)"])} cm / ${text(e["Weight (kg)"])} kg`],
    ]);
    if (exam && exam.status !== "NotAssessed") {
      section("Medical examination");
      facts([
        ["Status", exam.status.replace(/([a-z])([A-Z])/g, "$1 $2")], ["Tests ordered", String(exam.required_tests.length)], ["Completed", when(exam.completed_at)],
        ["Reported by", exam.reported_by ?? "—"], ["Clinic", exam.clinic?.name ?? "—"], ["Examination waived", exam.status === "Waived" ? (exam.waiver_reason ?? "Yes") : "No"],
      ]);
      const ai = (((exam.results ?? {}) as Record<string, any>).ai_review?.tests ?? {}) as Record<string, any>;
      const abnormal = new Set((exam.abnormal_findings ?? []).map((f) => f.test));
      if (exam.required_tests.length) {
        section("Test results");
        table(["Test", "Result", "Finding"], [62, 64, CW - 126],
          exam.required_tests.map((t) => {
            const r = ai[t.code];
            const flagged = r?.abnormal === true || abnormal.has(t.code);
            return [t.name, r?.readable === false || r == null ? "Not read" : text(r.value), r == null ? "—" : flagged ? "Abnormal" : r.abnormal === false ? "Normal" : "—"];
          }),
          (row) => (row[2] === "Abnormal" ? [225, 29, 72] : row[2] === "Normal" ? [5, 150, 105] : null));
      }
      if (exam.abnormal_findings?.length) {
        section("Abnormal findings");
        table(["Finding", "Value", "Loading"], [CW - 70, 40, 30],
          exam.abnormal_findings.map((f) => [`${f.label}${f.finding ? ` — ${f.finding}` : ""}`, `${f.value}${f.unit ? ` ${f.unit}` : ""}`, f.loading_pct ? `+${f.loading_pct}%` : "—"]));
      }
    }
  } else {
    section("Financial evidence");
    const rows = Object.entries(input.evidence).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => [k, text(v)]);
    if (rows.length) table(["Item", "Detail"], [62, CW - 62], rows);
    if (input.assessment) facts([["Financial risk score", `${input.assessment.score} / 100`]], 3);
  }

  if (input.documents.length) {
    section("Documents on file");
    table(["Document", "Type", "Status"], [CW - 92, 62, 30], input.documents.map((d) => [d.name, d.type.replace("Medical Report: ", "Report: "), d.status]));
  }

  section("Underwriter's rationale");
  paragraph(input.note?.trim() || "No rationale was recorded.");

  room(16);
  pdf.setFont("helvetica", "italic"); pdf.setFontSize(8); setInk(MUTED);
  for (const line of pdf.splitTextToSize("This is a specialist review only. It is not final application approval or an issued policy. The final decision is made on the underwriting case.", CW) as string[]) { pdf.text(line, M, y); y += 4; }

  // ── Footer on every page ──
  const pages = pdf.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    pdf.setPage(p);
    pdf.setDrawColor(RULE[0], RULE[1], RULE[2]); pdf.setLineWidth(0.3); pdf.line(M, 284, W - M, 284);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(7.5); setInk(MUTED);
    pdf.text("Confidential — contains personal and medical information", M, 289);
    pdf.text(`Page ${p} of ${pages}`, W - M, 289, { align: "right" });
  }
  pdf.save(`${input.track}-underwriting-report-${input.reference}.pdf`);
}
