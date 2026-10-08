import type { IconName } from "@/components/ui/Icon";

export type Product = {
  slug: string;
  name: string;
  icon: IconName;
  tagline: string;
  summary: string;
  audience: string;
  highlights: { title: string; body: string }[];
  steps: { title: string; body: string }[];
  // Illustrative demo plans — not a live rate card.
  plans: { name: string; term: string; cover: string; from: string }[];
  faq: { q: string; a: string }[];
};

export const products: Product[] = [
  {
    slug: "individual-life",
    name: "Individual Life",
    icon: "heart",
    tagline: "Term, whole life and endowment, quoted in seconds and underwritten the same day.",
    summary:
      "A single applicant moves from lead to issued policy without re-keying data. Indicative quotes are priced the moment a customer is added, and the underwriting case collects only the evidence that applicant's age, cover and health actually require.",
    audience: "Insurers and agencies selling individual protection and savings plans.",
    highlights: [
      {
        title: "Instant quotes for every eligible plan",
        body: "Adding a customer prices the whole plan catalogue using deterministic actuarial math. No model call, no waiting.",
      },
      {
        title: "Evidence that fits the risk",
        body: "The requirements engine decides what is mandatory from age, cover, cover-to-income, smoker status and BMI. A medical exam is booked only above the non-medical limit.",
      },
      {
        title: "Customer self-service links",
        body: "Applicants complete their own e-application and book a panel clinic slot through single-use, expiring links. No account needed.",
      },
      {
        title: "Counter-offers, not just yes or no",
        body: "Loadings and revised terms go back to the customer as a counter-offer they accept or decline, with the full history kept.",
      },
    ],
    steps: [
      { title: "Add the lead", body: "Agent, portal or copilot captures the applicant; quotes are ready immediately." },
      { title: "Open a case", body: "Six pre-underwriting gates collect disclosure, compliance, payment and history." },
      { title: "Underwrite", body: "Medical, financial and fraud risk are scored in parallel, then rules decide." },
      { title: "Issue", body: "Terms accepted, first premium collected, beneficiaries recorded, documents generated." },
    ],
    plans: [
      { name: "Term Life 20", term: "20 years", cover: "PKR 2M – 50M", from: "PKR 1,850 / mo" },
      { name: "Whole Life Secure", term: "To age 85", cover: "PKR 1M – 25M", from: "PKR 4,200 / mo" },
      { name: "Endowment Saver", term: "15 years", cover: "PKR 1M – 20M", from: "PKR 9,600 / mo" },
    ],
    faq: [
      {
        q: "Does an AI model decide whether to approve an application?",
        a: "No. Models help extract and assess evidence, but the verdict comes from a deterministic rule chain that can be audited and replayed.",
      },
      {
        q: "What if an applicant is missing documents?",
        a: "The case stays in Pending Documents and the risk engine is not called until mandatory requirements are satisfied or waived by an authorised user.",
      },
    ],
  },
  {
    slug: "family-takaful",
    name: "Family Takaful",
    icon: "users",
    tagline: "Shariah-aligned family cover with clear nominee shares and a transparent contribution model.",
    summary:
      "Family takaful is modelled the way families actually buy it: the head of the family and an optional spouse are the insured, underwritten members, and every other person is a nominee with an explicit percentage share.",
    audience: "Takaful operators and agents serving household cover.",
    highlights: [
      {
        title: "Head and spouse underwritten",
        body: "Only the people who are actually insured go through underwriting. Everyone else is a nominee, so there is no pointless medical evidence for children or parents.",
      },
      {
        title: "Nominee shares that must total 100",
        body: "Shares are captured per nominee and validated before issuance, with history kept for every change.",
      },
      {
        title: "Proposal stage you can resume",
        body: "Confirming family members creates a proposal, not an active policy, so the lead stays in progress until issuance.",
      },
      {
        title: "Takaful as a first-class type",
        body: "Conventional and takaful plans are distinct product categories, not a flag, so contributions and fund treatment stay separate.",
      },
    ],
    steps: [
      { title: "Create the family group", body: "Add the head, an optional spouse and nominees with their shares." },
      { title: "Validate and confirm", body: "Members are validated, then confirmed into a proposal." },
      { title: "Underwrite the insured", body: "The same AI-assisted pipeline runs for the head and spouse." },
      { title: "Issue and service", body: "Issue the policy, then manage contributions, endorsements and renewals." },
    ],
    plans: [
      { name: "Family Floater Takaful", term: "Annual", cover: "PKR 2M – 30M", from: "PKR 2,600 / mo" },
      { name: "Child Education & Marriage", term: "18 years", cover: "PKR 1M – 15M", from: "PKR 7,800 / mo" },
      { name: "Family Protection Plus", term: "20 years", cover: "PKR 3M – 40M", from: "PKR 3,400 / mo" },
    ],
    faq: [
      {
        q: "Why are only two family members underwritten?",
        a: "Because only they are insured. Other family members are nominees who receive a share of the benefit, which keeps the application short and the data honest.",
      },
      {
        q: "Can the same platform sell conventional and takaful plans?",
        a: "Yes. Each plan carries a product category (Conventional, Takaful or Bancassurance), and the workflows are shared where they should be.",
      },
    ],
  },
  {
    slug: "group-life",
    name: "Group Life",
    icon: "building",
    tagline: "Employer schemes from census upload to master policy, certificates and annual renewal.",
    summary:
      "One master policy is issued to the employer, and every employee becomes an insured member with a certificate. Benefit structures, census validation, scheme-level pricing and the employer's acceptance are all part of the flow.",
    audience: "Group-life and group family takaful teams working with corporate clients.",
    highlights: [
      {
        title: "Benefit classes that match HR reality",
        body: "Flat amount, grade or designation, length of service, or a multiple of salary, each with its own coverages.",
      },
      {
        title: "Census upload with validation",
        body: "Upload a CSV or XLSX, see row-level errors before anything is created, and reuse customers who already exist.",
      },
      {
        title: "Group underwriting and scheme pricing",
        body: "Members above the free cover limit go to the risk engine; the rest are priced as a scheme with a versioned quote.",
      },
      {
        title: "Endorsements and renewal",
        body: "Add, remove or change members mid-term with pro-rata premium, then renew the scheme each year from a refreshed census.",
      },
    ],
    steps: [
      { title: "Create the scheme", body: "Employer, master policy and Conventional or Takaful business type." },
      { title: "Define benefits and upload census", body: "Benefit classes first, then the employee list, validated row by row." },
      { title: "Underwrite and quote", body: "Group underwriting, then a corporate quote the employer can accept or revise." },
      { title: "Issue certificates", body: "Master policy goes active and each member receives a certificate." },
    ],
    plans: [
      { name: "Group Term Life", term: "Annual", cover: "Up to 60 × monthly salary", from: "Quoted per scheme" },
      { name: "Group Family Takaful", term: "Annual", cover: "Flat or graded", from: "Quoted per scheme" },
      { name: "Accidental Death & Disability", term: "Annual", cover: "% of base cover", from: "Quoted per scheme" },
    ],
    faq: [
      {
        q: "What is the difference between an insured member, a dependent and a beneficiary?",
        a: "They are separate records. One person can hold several roles, but a dependent is covered only if listed on the policy schedule, never just because they were named as a nominee.",
      },
      {
        q: "What happens if an employee already holds an individual policy?",
        a: "The census reuses the existing customer, so one person can be an individual policyholder and a group member at the same time.",
      },
    ],
  },
];

export function getProduct(slug: string) {
  return products.find((p) => p.slug === slug);
}
