import { ButtonLink } from "@/components/ui/Button";
import { Container } from "@/components/ui/Section";

export default function NotFound() {
  return (
    <Container className="py-24 text-center">
      <p className="eyebrow">404</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">This page does not exist</h1>
      <p className="mt-4 text-body">The link may be old, or the page may have moved.</p>
      <div className="mt-8 flex justify-center">
        <ButtonLink href="/">Back to home</ButtonLink>
      </div>
    </Container>
  );
}
