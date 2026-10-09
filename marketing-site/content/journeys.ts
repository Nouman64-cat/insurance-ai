import type { IconName } from "@/components/ui/Icon";

// Demo journeys: the same five-stage workflow for an individual, a family and an employer.
export type JourneyRow = { label: string; value: string; bar?: number };
export type JourneyStage = { label: string; icon: IconName; title: string; caption: string; rows: JourneyRow[]; result: { label: string; value: string; ok?: boolean } };
export type Journey = { name: string; who: string; stages: JourneyStage[] };

export const journeys: Journey[] = [
  {
    name: "Individual",
    who: "Term Life · Ahmed Khan, 34",
    stages: [
      { label: "Lead", icon: "users", title: "Agent adds the customer", caption: "From the phone, the portal or the copilot", rows: [{ label: "Customer", value: "Ahmed Khan" }, { label: "Profile", value: "34 · Non-smoker" }], result: { label: "Source", value: "Agent app" } },
      { label: "Quote", icon: "coin", title: "Every eligible plan, priced instantly", caption: "Deterministic maths, no waiting", rows: [{ label: "Cover amount", value: "PKR 5,000,000", bar: 72 }, { label: "Term", value: "20 years", bar: 48 }], result: { label: "Monthly", value: "PKR 3,450" } },
      { label: "Application", icon: "file", title: "E-application and pre-UW gates", caption: "Every gate is checked before underwriting", rows: [{ label: "Agent report", value: "Complete", bar: 100 }, { label: "First premium", value: "Received", bar: 100 }], result: { label: "Gates", value: "6 / 6", ok: true } },
      { label: "Underwriting", icon: "spark", title: "AI scores the risk, rules decide", caption: "Medical, financial and fraud in parallel", rows: [{ label: "Medical risk", value: "38 / 100", bar: 38 }, { label: "Financial risk", value: "22 / 100", bar: 22 }], result: { label: "Verdict", value: "Auto Approve", ok: true } },
      { label: "Issued", icon: "shield", title: "Policy issued and in force", caption: "Documents and free-look start automatically", rows: [{ label: "Policy no.", value: "POL-2026-0148" }, { label: "Free-look", value: "15 days", bar: 100 }], result: { label: "Status", value: "In force", ok: true } },
    ],
  },
  {
    name: "Family",
    who: "Family Takaful · Khan family",
    stages: [
      { label: "Lead", icon: "users", title: "Agent opens a family proposal", caption: "One lead, the whole household", rows: [{ label: "Family", value: "Khan family" }, { label: "Members", value: "5 people" }], result: { label: "Source", value: "Agent app" } },
      { label: "Members", icon: "heart", title: "Head and spouse are insured", caption: "Everyone else is a nominee with a share", rows: [{ label: "Insured", value: "Head + spouse", bar: 100 }, { label: "Nominee shares", value: "40 / 40 / 20", bar: 100 }], result: { label: "Shares", value: "100%", ok: true } },
      { label: "Quote", icon: "coin", title: "Family plan priced instantly", caption: "Contribution model shown transparently", rows: [{ label: "Cover amount", value: "PKR 8,000,000", bar: 80 }, { label: "Term", value: "25 years", bar: 60 }], result: { label: "Monthly", value: "PKR 6,200" } },
      { label: "Underwriting", icon: "spark", title: "Only the insured are underwritten", caption: "Each person gets their own verdict", rows: [{ label: "Head", value: "Auto Approve", bar: 100 }, { label: "Spouse", value: "+25% loading", bar: 62 }], result: { label: "Verdict", value: "Approve with Loading", ok: true } },
      { label: "Issued", icon: "shield", title: "Proposal becomes a policy", caption: "Nominees and documents are locked in", rows: [{ label: "Policy no.", value: "POL-2026-0149" }, { label: "Nominee shares", value: "100%", bar: 100 }], result: { label: "Status", value: "In force", ok: true } },
    ],
  },
  {
    name: "Corporate",
    who: "Group Life · Crescent Textiles",
    stages: [
      { label: "Lead", icon: "building", title: "Employer account created", caption: "Added by an agent or self-serve", rows: [{ label: "Employer", value: "Crescent Textiles" }, { label: "Employees", value: "248" }], result: { label: "Source", value: "Portal" } },
      { label: "Census", icon: "file", title: "Census uploaded and validated", caption: "Errors are caught row by row", rows: [{ label: "Rows validated", value: "248 / 248", bar: 100 }, { label: "Errors", value: "0", bar: 0 }], result: { label: "Census", value: "Valid", ok: true } },
      { label: "Quote", icon: "coin", title: "Scheme priced by benefit class", caption: "Salary multiples per grade", rows: [{ label: "Grade A", value: "3x salary", bar: 78 }, { label: "Grade B", value: "2x salary", bar: 52 }], result: { label: "Annual", value: "PKR 4.2M" } },
      { label: "Underwriting", icon: "spark", title: "Group underwriting", caption: "Group rules applied, outliers referred", rows: [{ label: "Within group rules", value: "242", bar: 97 }, { label: "Referred to review", value: "6", bar: 4 }], result: { label: "Verdict", value: "Approved", ok: true } },
      { label: "Issued", icon: "shield", title: "Master policy and certificates", caption: "Every employee gets a certificate", rows: [{ label: "Certificates", value: "248 issued", bar: 100 }, { label: "Renewal", value: "In 12 months" }], result: { label: "Status", value: "In force", ok: true } },
    ],
  },
];
