"use client";

import { useEffect, useState, type ComponentProps, type ComponentType } from "react";
import type ReactMarkdownType from "react-markdown";

// react-markdown (and the parser behind it) is only needed once an AI summary has arrived, so it is loaded then
// instead of with the page. Until it is there the text is shown as it is, so nothing jumps or goes blank.

type Props = ComponentProps<typeof ReactMarkdownType>;

let loaded: ComponentType<Props> | null = null;
let loading: Promise<ComponentType<Props>> | null = null;

function load(): Promise<ComponentType<Props>> {
  loading ??= import("react-markdown").then((m) => (loaded = m.default as ComponentType<Props>));
  return loading;
}

export default function LazyMarkdown(props: Props) {
  const [Markdown, setMarkdown] = useState<ComponentType<Props> | null>(() => loaded);

  useEffect(() => {
    if (Markdown) return;
    let cancelled = false;
    load().then((component) => { if (!cancelled) setMarkdown(() => component); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [Markdown]);

  if (Markdown) return <Markdown {...props} />;
  return <div className="whitespace-pre-wrap">{props.children}</div>;
}
