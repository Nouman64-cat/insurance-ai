import type { IconName } from "@/components/ui/Icon";

export const lifecycle: { title: string; body: string; icon: IconName }[] = [
  { title: "Lead", body: "Agent, portal or copilot adds the customer, family or employer.", icon: "users" },
  { title: "Quote", body: "Every eligible plan is priced instantly with deterministic math.", icon: "coin" },
  { title: "Case & gates", body: "E-application, agent report, compliance, first premium, history, medical.", icon: "file" },
  { title: "Underwriting", body: "Parallel medical, financial and fraud scoring, then a rule-based verdict.", icon: "spark" },
  { title: "Issuance", body: "Counter-offer, reinsurance, beneficiaries and documents gate issue.", icon: "shield" },
  { title: "In force", body: "Free-look, premiums, endorsements and renewals on one state machine.", icon: "clock" },
  { title: "Claims", body: "Triage, fraud checks, adjudication, payout and recovery.", icon: "heart" },
];

// Counts describe the product's structure, not performance claims.
export const facts = [
  { value: "7", label: "underwriting verdicts" },
  { value: "6", label: "pre-underwriting gates" },
  { value: "3", label: "LLM providers, with fallback" },
  { value: "1", label: "policy state machine" },
];

export const pillars: { title: string; body: string; icon: IconName }[] = [
  {
    title: "Rules decide, models assist",
    body: "LLMs extract and interpret. Approve, load, postpone or decline is chosen by a deterministic rule chain.",
    icon: "shield",
  },
  {
    title: "Auditable by design",
    body: "Every policy status change runs through one state machine and leaves an immutable event behind.",
    icon: "file",
  },
  {
    title: "Multi-tenant and role-aware",
    body: "Each insurer runs in an isolated tenant with its own plans, rules and users, behind JWT authentication.",
    icon: "lock",
  },
  {
    title: "Built for Pakistan",
    body: "CNIC handling, PKR pricing, takaful as a distinct product type and PEP and sanctions screening.",
    icon: "building",
  },
];

export const homeFaq = [
  {
    q: "Does the AI approve or decline applications on its own?",
    a: "Models score evidence, but the verdict is picked by a deterministic decision engine. Borderline cases go to a human underwriter, and the copilot never mutates data without confirmation.",
  },
  {
    q: "Which LLM providers are supported?",
    a: "Google Gemini, OpenAI and Anthropic. A super admin sets the primary and fallback provider at runtime and credentials are encrypted at rest.",
  },
  {
    q: "Can we sell both conventional and takaful products?",
    a: "Yes. Plans carry a product category, and group and family takaful follow the same lifecycle with their own fund concepts.",
  },
  {
    q: "Is this a live product?",
    a: "Insurance AI is currently a prototype. The workflows shown here are built and running, while rates, plans and figures on this site are demo data.",
  },
];
