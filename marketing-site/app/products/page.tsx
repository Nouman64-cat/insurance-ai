import { PageHero, Section } from "@/components/ui/Section";
import { ProductCards } from "@/components/sections/FeatureCards";
import { JourneyExplorer } from "@/components/sections/JourneyExplorer";
import { CompareBand, FaqBand } from "@/components/blocks/Blocks";
import { CtaBand } from "@/components/sections/CtaBand";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata(
  "Products",
  "Individual life, family takaful and group life on one underwriting and servicing platform.",
  "/products"
);

const faq = [
  {
    q: "Can we offer conventional and takaful plans together?",
    a: "Yes. Plans carry a product category, and group and family takaful follow the same lifecycle with their own fund concepts.",
  },
  {
    q: "Who is underwritten on a family policy?",
    a: "The head and an optional spouse. Everyone else is a nominee with a share, and the nominee shares must total 100.",
  },
  {
    q: "How does a group scheme start?",
    a: "The employer's census is uploaded and validated row by row, then the scheme is priced by benefit class and underwritten as a group.",
  },
  {
    q: "Can plans and rates be changed?",
    a: "Plans, rules and users belong to each insurer's tenant, so catalogues are configured per insurer. The figures on this site are demo data.",
  },
];

export default function ProductsPage() {
  return (
    <>
      <PageHero
        eyebrow="Products"
        art="feed"
        title="Cover for individuals, families and employers"
        description="Each product runs on the same lifecycle, so an insurer can add a line of business without adding a new system."
      />
      <Section>
        <ProductCards />
      </Section>
      <JourneyExplorer />
      <CompareBand
        eyebrow="Side by side"
        title="Where the three products differ"
        description="Same platform, same audit trail. The differences sit where the business actually differs."
        heads={["Individual Life", "Family Takaful", "Group Life"]}
        rows={[
          { label: "Who is insured", cells: ["The applicant", "The head and an optional spouse", "Each employee in the scheme"] },
          { label: "Who else is named", cells: ["Beneficiaries", "Nominees, with shares totalling 100%", "Beneficiaries per member"] },
          { label: "How it starts", cells: ["A lead, then quote and e-application", "A family proposal that can be resumed", "An employer account and a census upload"] },
          { label: "Underwriting", cells: ["The full AI and rules pipeline per applicant", "Head and spouse underwritten", "Group underwriting and scheme pricing"] },
          { label: "Pricing", cells: ["Instant quote for every eligible plan", "A family plan with a transparent contribution model", "Priced per scheme by benefit class"] },
        ]}
      />
      <FaqBand items={faq} />
      <CtaBand />
    </>
  );
}
