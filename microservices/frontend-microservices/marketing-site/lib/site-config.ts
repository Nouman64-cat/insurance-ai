export const siteConfig = {
  name: "GetInsuredAI",
  developer: "Rizviz International Impex",
  tagline: "Connected insurance operations with role-specific AI copilots",
  description:
    "GetInsuredAI connects lead assessment, proposals, medical and financial underwriting, claims, Finance payment records, commissions and customer servicing. Role-specific copilots assist while authorised staff control decisions.",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002",
  portalUrl: process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://localhost:3000",
} as const;

export const mainNav = [
  { label: "Products", href: "/products" },
  { label: "Platform", href: "/platform" },
  { label: "About", href: "/about" },
] as const;

export const footerNav = [
  {
    title: "Products",
    links: [
      { label: "Individual Life", href: "/products/individual-life" },
      { label: "Family Takaful", href: "/products/family-takaful" },
      { label: "Group Life", href: "/products/group-life" },
    ],
  },
  {
    title: "Platform",
    links: [
      { label: "AI Underwriting", href: "/platform/ai-underwriting" },
      { label: "AI Copilot", href: "/platform/ai-copilot" },
      { label: "Claims", href: "/platform/claims" },
      { label: "Fraud Intelligence", href: "/platform/fraud-intelligence" },
      { label: "Agent App", href: "/platform/agent-app" },
      { label: "Finance", href: "/platform/finance" },
      { label: "Commissions", href: "/platform/commissions" },
      { label: "Customer Experience", href: "/platform/customer-experience" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Contact", href: "/contact" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", href: "/legal/privacy" },
      { label: "Terms", href: "/legal/terms" },
    ],
  },
] as const;
