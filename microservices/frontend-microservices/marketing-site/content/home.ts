import type { IconName } from "@/components/ui/Icon";

export const lifecycle: { title: string; body: string; icon: IconName }[] = [
  {
    "title": "Lead",
    "body": "Capture customers and screen profile risk before a proposal exists.",
    "icon": "users"
  },
  {
    "title": "Proposal",
    "body": "Select a plan, prepare the proposal and track initial premium receipt.",
    "icon": "coin"
  },
  {
    "title": "Evidence",
    "body": "Collect disclosure, agent reports, compliance checks and required documents.",
    "icon": "file"
  },
  {
    "title": "Underwriting",
    "body": "Medical and financial specialists review evidence with advisory AI findings.",
    "icon": "spark"
  },
  {
    "title": "Issuance",
    "body": "Authorised staff complete approval, verification and issuance requirements.",
    "icon": "shield"
  },
  {
    "title": "In force",
    "body": "Manage premiums, policy servicing, renewals and commission earnings.",
    "icon": "clock"
  },
  {
    "title": "Claims & Finance",
    "body": "Review the claim, authorise settlement, record external payments and reconcile.",
    "icon": "heart"
  }
];

export const facts = [
  {
    "value": "2",
    "label": "specialist underwriting tracks"
  },
  {
    "value": "7",
    "label": "stages in the claims workflow"
  },
  {
    "value": "2",
    "label": "portal languages: English and Urdu"
  },
  {
    "value": "1",
    "label": "connected operational record"
  }
];

export const pillars: { title: string; body: string; icon: IconName }[] = [
  {
    "title": "AI assists, people decide",
    "body": "Evidence analysis and configurable rules support authorised human reviews and decisions.",
    "icon": "shield"
  },
  {
    "title": "Traceable operations",
    "body": "Assessments, review findings, approval records and payment references stay linked to the operational record.",
    "icon": "file"
  },
  {
    "title": "Workspaces by role",
    "body": "Tenant and role permissions govern what each portal, mobile app and copilot can read or change.",
    "icon": "lock"
  },
  {
    "title": "Built for Pakistan",
    "body": "CNIC handling, PKR amounts, English and Urdu interfaces, conventional insurance and takaful workflows.",
    "icon": "building"
  }
];

export const homeFaq = [
  {
    "q": "Can AI make the final decision on a claim?",
    "a": "AI produces recommendations. Medical and Financial Underwriters record their specialist reviews; Admin records the human underwriting outcome for a claim referral, and the Claims Manager makes the claim decision. AI output does not replace these approvals."
  },
  {
    "q": "How are Claims Manager and Finance responsibilities separated?",
    "a": "The Claims Manager prepares settlement payees, verifies their identity and bank details, then authorises payment. Finance records payments already made outside the system using actual transaction references and handles reconciliation. Recording a payout does not initiate a bank transfer."
  },
  {
    "q": "Which teams have their own copilots?",
    "a": "Role-specific assistants support authorised operational work, including Claims Manager, Finance, medical underwriting and financial underwriting. Their tools and skills follow the signed-in role and tenant. Copilots ask for missing evidence and cannot bypass backend permissions."
  },
  {
    "q": "Does GetInsuredAI support Urdu?",
    "a": "The portals support English and Urdu. Live voice is configured to match English or Urdu speech, with Urdu transcription guidance and Urdu-script captions. Recognition accuracy depends on the recording conditions."
  },
  {
    "q": "How are commissions created?",
    "a": "Commission earnings are created from recorded premium receipts after policy issuance, using configured acquisition-source allocation and Rule Engine rates. Recurring eligibility and rates follow the applicable rules; payable dates use the source start-date day in the month after collection."
  },
  {
    "q": "Are the records on this website real?",
    "a": "No. The people, plans, amounts and interface examples shown here are illustrative demo data. Product availability, rules, integrations and permissions depend on the insurer configuration."
  }
];
