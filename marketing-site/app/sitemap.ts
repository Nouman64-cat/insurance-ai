import type { MetadataRoute } from "next";
import { platformFeatures } from "@/content/platform";
import { products } from "@/content/products";
import { siteConfig } from "@/lib/site-config";

export default function sitemap(): MetadataRoute.Sitemap {
  const paths = [
    "",
    "/products",
    ...products.map((p) => `/products/${p.slug}`),
    "/platform",
    ...platformFeatures.map((f) => `/platform/${f.slug}`),
    "/pricing",
    "/about",
    "/contact",
    "/legal/privacy",
    "/legal/terms",
  ];
  return paths.map((path) => ({ url: `${siteConfig.url}${path}`, lastModified: new Date() }));
}
