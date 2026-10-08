import type { IconName } from "@/components/ui/Icon";

export type MockKind = "underwriting" | "copilot" | "claims" | "fraud" | "agent";

export type PlatformFeature = {
  slug: string;
  name: string;
  icon: IconName;
  mock: MockKind;
  tagline: string;
  summary: string;
  points: { title: string; body: string }[];
  guarantees: string[];
};

export const platformFeatures: PlatformFeature[] = [
  {
    slug: "ai-underwriting",
    name: "AI Underwriting",
    icon: "spark",
    mock: "underwriting",
    tagline: "Models assess the evidence. Deterministic rules make the decision.",
    summary:
      "Medical, financial and fraud risk are scored in parallel by a LangGraph workflow, combining LLM analysis with hard floors and ceilings. A separate rule-based decision engine then picks one of seven outcomes, so every verdict can be explained and replayed.",
    points: [
      {
        title: "Requirements engine first",
        body: "Mandatory evidence is derived from age, cover, cover-to-income, smoker status, BMI and declared conditions. Until it is satisfied, the risk engine is never called.",
      },
      {
        title: "Document intelligence",
        body: "OCR and visual analysis extract and verify uploaded documents, and a summariser produces underwriter notes.",
      },
      {
        title: "Seven explicit verdicts",
        body: "Auto Approve, Approve with Loading, Human Review, Request Additional Evidence, Fraud Investigation, Postpone, or Decline.",
      },
      {
        title: "Streaming evaluation",
        body: "Watch each node of the workflow complete live, or run it asynchronously over Kafka for bulk jobs.",
      },
    ],
    guarantees: [
      "Final branching is rule-based, not model-generated",
      "Primary and fallback LLM provider configurable at runtime",
      "Every evaluation is persisted and auditable",
    ],
  },
  {
    slug: "ai-copilot",
    name: "AI Copilot",
    icon: "chat",
    mock: "copilot",
    tagline: "A conversational agent that does the work, and asks before it changes anything.",
    summary:
      "The copilot looks things up, onboards leads, runs the underwriting and claims pipelines and navigates the portal. Every action that changes data is gated in code, not just in the prompt.",
    points: [
      {
        title: "Confirmation before mutation",
        body: "Creating a customer, opening a case, uploading a document or running a risk assessment always pauses for an explicit yes or no.",
      },
      {
        title: "Clarifying questions",
        body: "Missing or invalid inputs trigger a question instead of a guess. Near-valid input such as a CNIC without dashes is corrected automatically.",
      },
      {
        title: "Autonomous journeys",
        body: "Underwriting and claims run end to end, and stop for a human when documents are missing, a decision needs review, or a payout is large.",
      },
      {
        title: "Role-aware tools",
        body: "What the copilot may do depends on the signed-in role and on whether the user is on web or mobile.",
      },
    ],
    guarantees: [
      "Permission gate enforced in code, with real pause and resume",
      "Conversations survive restarts through persistent checkpoints",
      "Token usage metered per call",
    ],
  },
  {
    slug: "claims",
    name: "Claims",
    icon: "file",
    mock: "claims",
    tagline: "From first notice of loss to payout, with a human wherever it matters.",
    summary:
      "Claims move through triage, document audit, fraud and contestability checks, adjudication and disbursement. Rule-engine adjudication handles the routine; large or suspicious claims are routed to a person.",
    points: [
      {
        title: "Registered and triaged on arrival",
        body: "First notice of loss is captured once and the claim is triaged against the policy state at the date of loss.",
      },
      {
        title: "Contestability re-underwriting",
        body: "Early claims can be referred back to underwriting to test the original disclosure.",
      },
      {
        title: "Manager review thresholds",
        body: "Claims above a configured amount, or referred by a rule, wait for manager sign-off before payout.",
      },
      {
        title: "Reinsurance recovery",
        body: "Referral and recovery against the reinsurance split are part of the claim record.",
      },
    ],
    guarantees: [
      "Twelve explicit claim statuses",
      "Claim documents stored with the case",
      "Full status history for audit",
    ],
  },
  {
    slug: "fraud-intelligence",
    name: "Fraud Intelligence",
    icon: "graph",
    mock: "fraud",
    tagline: "A relationship graph that finds what a single application cannot show.",
    summary:
      "Every evaluation reads from and writes to a Memgraph graph of customers. Clusters of applicants sharing a registration area, an occupation, an outlier income or a coverage pattern raise a probability that feeds the underwriting decision.",
    points: [
      {
        title: "Ring detection",
        body: "Customers are linked by shared registration area and occupation cluster, and queried for coordinated patterns.",
      },
      {
        title: "Income and coverage outliers",
        body: "Declared income and requested cover are compared against the surrounding cluster.",
      },
      {
        title: "Gets stronger over time",
        body: "Each evaluation enriches the graph, so signals improve as more applications are seen.",
      },
      {
        title: "Tenant isolated",
        body: "Graph queries never cross tenant boundaries, and a graph outage never blocks an evaluation.",
      },
    ],
    guarantees: [
      "Severity bands are deterministic, not model-picked",
      "High or critical severity routes to Fraud Investigation",
      "Failures in the graph layer degrade gracefully",
    ],
  },
  {
    slug: "agent-app",
    name: "Agent App",
    icon: "phone",
    mock: "agent",
    tagline: "Everything a field agent needs, in their pocket.",
    summary:
      "A mobile app for field agents to manage leads, submit proposals, send e-application links, file their confidential report, follow underwriting and check commissions. Leads created anywhere appear without a refresh.",
    points: [
      {
        title: "Lead board",
        body: "Leads across individual, family and corporate categories, kept in sync with the portal.",
      },
      {
        title: "Customer e-application",
        body: "Send a tokenised link so the customer completes their own disclosure and declaration.",
      },
      {
        title: "Confidential report",
        body: "Capture moral-hazard, financial-standing and lifestyle observations that feed underwriting.",
      },
      {
        title: "Commission visibility",
        body: "See earnings and the commission rate card, and ask the copilot for the next step.",
      },
    ],
    guarantees: [
      "Available to the Agent role",
      "Copilot on mobile runs with tighter tool permissions",
      "Notifications raised when lead state changes",
    ],
  },
];

export function getPlatformFeature(slug: string) {
  return platformFeatures.find((f) => f.slug === slug);
}
