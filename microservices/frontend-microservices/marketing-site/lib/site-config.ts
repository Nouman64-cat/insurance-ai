export const siteConfig = {
  name: "Insurance AI",
  developer: "Rizviz International Impex",
  tagline: "AI-assisted underwriting and policy servicing for life and takaful insurers",
  description:
    "Insurance AI takes a policy from lead to claim on one auditable platform: AI underwriting with deterministic decision rules, a fraud graph, a gated AI copilot and a field-agent mobile app.",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002",
  portalUrl: process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://localhost:3000",
} as const;

export const mainNav = [
  { label: "Products", href: "/products" },
  { label: "Platform", href: "/platform" },
  { label: "Pricing", href: "/pricing" },
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
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Pricing", href: "/pricing" },
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
