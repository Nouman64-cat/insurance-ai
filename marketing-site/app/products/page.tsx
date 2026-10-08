import { PageHero, Section } from "@/components/ui/Section";
import { ProductCards } from "@/components/sections/FeatureCards";
import { CtaBand } from "@/components/sections/CtaBand";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata(
  "Products",
  "Individual life, family takaful and group life on one underwriting and servicing platform.",
  "/products"
);

export default function ProductsPage() {
  return (
    <>
      <PageHero
        eyebrow="Products"
        art="family"
        title="Cover for individuals, families and employers"
        description="Each product runs on the same lifecycle, so an insurer can add a line of business without adding a new system."
      />
      <Section>
        <ProductCards />
      </Section>
      <CtaBand />
    </>
  );
}
