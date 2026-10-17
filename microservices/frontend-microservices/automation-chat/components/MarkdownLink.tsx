"use client";

import type { AnchorHTMLAttributes } from "react";
import { appLinkUrl } from "@/lib/portal";

/** The link renderer for chat replies: page links open on the app that serves them (portal or Underwriting
 *  Workbench) in a new tab, like the reply's own navigate buttons; other links open in a new tab as written. */
export default function MarkdownLink({ href, children, node: _node, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  if (href?.startsWith("#") || href?.startsWith("mailto:") || href?.startsWith("tel:")) {
    return <a href={href} {...rest}>{children}</a>;
  }
  return (
    <a href={appLinkUrl(href) ?? href} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  );
}
