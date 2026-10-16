import { tx } from "@/lib/i18n/tx";
import BrandSplash from "@/components/BrandSplash";

export default function Loading() {
  return <BrandSplash fullScreen={false} message={tx("Loading your workspace…")} />;
}
