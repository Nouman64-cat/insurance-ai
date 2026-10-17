// Lets a page embedded in the Copilot's inline panel tell the chat something
// happened inside it (see the "message" listener in CopilotInterface). A no-op
// when the page is opened on its own, so callers need no embed check.
// The page that embeds this one is the Automation Chat app, on its own origin (or this origin when embedded by the
// dashboard itself). Only ever message an origin we expect.
export function parentOrigin(): string {
  const chat = (process.env.NEXT_PUBLIC_AUTOMATION_URL || "http://localhost:3004").replace(/\/+$/, "");
  try {
    const ref = document.referrer ? new URL(document.referrer).origin : "";
    const chatOrigin = new URL(chat).origin;
    if (ref === chatOrigin) return chatOrigin;
  } catch { /* fall through */ }
  return window.location.origin;
}

export function notifyParentPortal(event: string, detail?: Record<string, unknown>) {
  if (typeof window === "undefined" || window.parent === window) return;
  try {
    window.parent.postMessage({ source: "insurance-ai-portal", type: event, ...detail }, parentOrigin());
  } catch {
    // No listener — the page still works standalone.
  }
}
