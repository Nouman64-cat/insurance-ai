import type { IconName } from "@/components/ui/Icon";

export type MockKind = "underwriting" | "copilot" | "claims" | "fraud" | "agent" | "finance" | "commissions" | "customer";

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
    "slug": "ai-underwriting",
    "name": "AI Underwriting",
    "icon": "spark",
    "mock": "underwriting",
    "tagline": "Separate specialist reviews. Advisory AI. Human outcomes.",
    "summary": "Screen lead profile risk before a proposal, then work application-level medical and financial reviews through their own evidence and readiness checks. AI recommendations support the authorised human review.",
    "points": [
      {
        "title": "Lead risk screening",
        "body": "Run and save a customer profile assessment before creating a proposal or underwriting case."
      },
      {
        "title": "Specialist workbenches",
        "body": "Medical and Financial Underwriters manage assigned reviews, questionnaires, evidence and findings."
      },
      {
        "title": "Claim referral analysis",
        "body": "Run claim-specific medical or financial AI analysis against existing evidence and plan terms, without new-business examination requirements."
      },
      {
        "title": "Human underwriting outcomes",
        "body": "For claim referrals, Admin records Proceed or Decline after specialist reviews. The Claims Manager retains the actual claim decision."
      }
    ],
    "guarantees": [
      "AI recommendations remain separate from human outcomes",
      "Readiness checks follow the application or claim context",
      "Evidence and review rationale stay with the record"
    ]
  },
  {
    "slug": "ai-copilot",
    "name": "AI Copilots",
    "icon": "chat",
    "mock": "copilot",
    "tagline": "The right assistant, tools and workflow for each role.",
    "summary": "Claims, Finance, medical and financial underwriting copilots use a shared capability and skill framework. They read current records, ask for missing details and work within the signed-in role.",
    "points": [
      {
        "title": "Skills and specialist agents",
        "body": "Workflows bind relevant tools for the current role, task and record rather than offering every operation to every user."
      },
      {
        "title": "Requested actions, verified results",
        "body": "Explicit requests authorise the requested work. The assistant asks for missing evidence or required decisions and reports owning-service results."
      },
      {
        "title": "Text and live voice",
        "body": "Use chat or live voice with English and Urdu language handling, captions, interruption and the same authorised business workflow."
      },
      {
        "title": "Portal handoff",
        "body": "Open the relevant record, attach documents or return to the role’s portal when a task needs the screen."
      }
    ],
    "guarantees": [
      "Backend role and tenant permissions apply to tools",
      "Human decisions and actual payment references are required inputs",
      "Unknown mutation outcomes are checked before retrying"
    ]
  },
  {
    "slug": "claims",
    "name": "Claims Management",
    "icon": "file",
    "mock": "claims",
    "tagline": "From notification to settlement, with clear ownership at every step.",
    "summary": "Follow intimation, eligibility, documents, investigation and assessment, claim decision, settlement and closure. Specialist claim referrals, settlement authorisation and Finance recording remain distinct.",
    "points": [
      {
        "title": "Evidence and requirements",
        "body": "Track the claim’s checklist, documents, exclusions, waiting periods and contestability findings."
      },
      {
        "title": "Specialist claim referrals",
        "body": "Assign medical and financial reviews. AI supplies recommendations; specialists and authorised staff record human outcomes."
      },
      {
        "title": "Claims Manager authorisation",
        "body": "Prepare payees, verify identity and bank details, then authorise the approved settlement within delegated limits."
      },
      {
        "title": "Finance handoff",
        "body": "Finance records external payments with real references and reconciles them. Reconciliation and closure are separate actions."
      }
    ],
    "guarantees": [
      "Approval alone does not authorise payment",
      "Claims Manager and Finance duties are separated",
      "Status history and recorded findings support review"
    ]
  },
  {
    "slug": "fraud-intelligence",
    "name": "Fraud Intelligence",
    "icon": "graph",
    "mock": "fraud",
    "tagline": "Connected risk signals for a human investigation.",
    "summary": "Relationship analysis, duplicate checks and document findings help reviewers identify suspicious patterns. Signals provide evidence for investigation rather than a standalone claim decision.",
    "points": [
      {
        "title": "Relationship patterns",
        "body": "Review shared customer attributes and connected application patterns."
      },
      {
        "title": "Financial outliers",
        "body": "Compare income and coverage signals alongside the applicant’s evidence."
      },
      {
        "title": "Duplicate claim checks",
        "body": "Review possible duplicate insured events without creating replacement claims to change eligibility."
      },
      {
        "title": "Recorded rationale",
        "body": "Keep concerns, investigative findings and authorised outcomes linked to the case or claim."
      }
    ],
    "guarantees": [
      "Risk signals require interpretation",
      "Findings support evidence-based review",
      "Operational permissions remain in force"
    ]
  },
  {
    "slug": "agent-app",
    "name": "Agent App",
    "icon": "phone",
    "mock": "agent",
    "tagline": "Lead capture, proposals and earnings for field teams.",
    "summary": "Agents work with customer leads, selected plans, proposal progress and their commission information. Their mobile copilot follows the mobile role’s permitted tools.",
    "points": [
      {
        "title": "Lead management",
        "body": "Work individual, family and corporate leads with the connected portal records."
      },
      {
        "title": "Customer disclosure",
        "body": "Send e-application links so customers provide their own answers and declarations."
      },
      {
        "title": "Agent confidential report",
        "body": "Capture the agent’s observations and supplied income or occupation verification evidence."
      },
      {
        "title": "Commission visibility",
        "body": "Follow earnings generated from eligible premium receipts and the applicable commission setup."
      }
    ],
    "guarantees": [
      "Mobile permissions are scoped to the agent",
      "Customers provide their own declarations",
      "Earnings follow receipts and configured rules"
    ]
  },
  {
    "slug": "finance",
    "name": "Finance Workspace",
    "icon": "coin",
    "mock": "finance",
    "tagline": "Record external payments. Keep settlement authority with Claims.",
    "summary": "Finance has a payments dashboard, an awaiting-payout queue, a payment register and reconciliation work. It records payments already made outside GetInsuredAI; it does not initiate a bank transfer.",
    "points": [
      {
        "title": "Live payment register",
        "body": "Search by claim, payee, policy or bank reference and filter recorded payment statuses."
      },
      {
        "title": "Authorised settlements",
        "body": "Review verified payees and the Claims Manager’s authorisation before recording payment."
      },
      {
        "title": "Actual bank references",
        "body": "Record a selected method, real transaction references and notes, with separate references for split payees."
      },
      {
        "title": "Finance Copilot",
        "body": "Inspect payments, record an authorised external payout and reconcile on request using Finance-scoped tools."
      }
    ],
    "guarantees": [
      "Finance cannot approve claims or authorise its own settlement",
      "Recording Paid status does not send a bank transfer",
      "Already recorded payouts are protected against duplicate submission"
    ]
  },
  {
    "slug": "commissions",
    "name": "Commission Management",
    "icon": "coin",
    "mock": "commissions",
    "tagline": "Premium receipts become traceable commission records.",
    "summary": "Commission earnings are generated from eligible premium receipts after policy issuance. Rule Engine settings determine rates and recurring eligibility; acquisition-source allocation identifies who earns the commission.",
    "points": [
      {
        "title": "Receipt-driven earnings",
        "body": "The first eligible premium produces commission; recurring commissions follow configured rates and eligibility."
      },
      {
        "title": "Payable dates",
        "body": "Use the acquisition source’s start-date day in the month after premium collection, with month-end handling."
      },
      {
        "title": "Editable records",
        "body": "Authorised admins can correct rates or payable dates with a reason and recorded adjustment history. Reserved payouts lock the earning."
      },
      {
        "title": "Payout and exception workflow",
        "body": "Review earnings, exceptions and commission disbursement batches separately from claim payment recording."
      }
    ],
    "guarantees": [
      "Rules determine rates and recurring eligibility",
      "Corrections retain original posting information and history",
      "Payout reservation protects earnings from concurrent edits"
    ]
  },
  {
    "slug": "customer-experience",
    "name": "Customer Experience",
    "icon": "users",
    "mock": "customer",
    "tagline": "Connected customer journeys across portal, mobile and service desks.",
    "summary": "Customers can access their insurer’s supported self-service journeys through customer-facing apps and portals. Operational teams handle requests and records through their own authorised workspaces.",
    "points": [
      {
        "title": "Customer portal and app",
        "body": "Access customer policy and service journeys through the insurer’s configured channels."
      },
      {
        "title": "Disclosure and evidence",
        "body": "Complete questionnaires and provide requested documents without staff inventing customer declarations."
      },
      {
        "title": "Service requests",
        "body": "Track supported policy changes and customer-service requests through their owning workflows."
      },
      {
        "title": "Connected insurer teams",
        "body": "Agent, underwriting, claims and service teams work on shared records while role permissions control access."
      }
    ],
    "guarantees": [
      "Available journeys follow insurer configuration",
      "Customer declarations remain the customer’s responsibility",
      "Tenant and role checks apply across channels"
    ]
  }
];

export function getPlatformFeature(slug: string) {
  return platformFeatures.find((f) => f.slug === slug);
}
