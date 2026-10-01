// Lets a page embedded in the Copilot's inline panel tell the chat something
// happened inside it (see the "message" listener in CopilotInterface). A no-op
// when the page is opened on its own, so callers need no embed check.
export function notifyParentPortal(event: string, detail?: Record<string, unknown>) {
  if (typeof window === "undefined" || window.parent === window) return;
  try {
    window.parent.postMessage({ source: "insurance-ai-portal", type: event, ...detail }, window.location.origin);
  } catch {
    // No listener — the page still works standalone.
  }
}
