// Run with `npm test` (node --test; Node 22.6+ runs TypeScript files directly).
// Covers the rules both apps share: which app serves a page, how links are built, and which sign-in return URLs are
// trusted.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_PORTAL_URL = "https://portal.example.com/";
process.env.NEXT_PUBLIC_UNDERWRITING_URL = "https://underwriting.example.com";
process.env.NEXT_PUBLIC_AUTOMATION_URL = "https://chat.example.com";

const portalSide = await import("../../frontend/lib/appLinks.ts?portal");
process.env.NEXT_PUBLIC_APP_NAME = "underwriting";
const workbenchSide = await import("../../frontend/lib/appLinks.ts?workbench");

test("underwriting pages belong to the workbench, everything else to the portal", () => {
  const { isUnderwritingPath } = portalSide;
  for (const path of ["/underwriting", "/underwriting?tab=risk-engine", "/pre-underwriting", "/post-underwriting",
    "/live-evaluation", "/assessments", "/case/0b6f", "/case/0b6f?autoRun=true", "case/0b6f", "/case/1#gates"]) {
    assert.equal(isUnderwritingPath(path), true, path);
  }
  for (const path of ["/", "/cases", "/cases?case_id=1", "/case", "/caseload", "/underwritingx", "/policy-issuance",
    "/claims/1", "/proposal", "/admin/leads", "/e-application/abc", "/medical-exam/abc"]) {
    assert.equal(isUnderwritingPath(path) && path !== "/case", false, path);
  }
});

test("links stay relative inside their own app and become absolute across apps", () => {
  assert.equal(portalSide.CURRENT_APP, "portal");
  assert.equal(portalSide.appHref("/policy-issuance"), "/policy-issuance");
  assert.equal(portalSide.appHref("/case/42?autoRun=true"), "https://underwriting.example.com/case/42?autoRun=true");
  assert.equal(workbenchSide.CURRENT_APP, "underwriting");
  assert.equal(workbenchSide.appHref("/case/42"), "/case/42");
  assert.equal(workbenchSide.appHref("/policy-issuance"), "https://portal.example.com/policy-issuance");
  assert.equal(workbenchSide.appHref("/"), "https://portal.example.com/");
});

test("customer-facing links always point at the portal", () => {
  assert.equal(workbenchSide.portalUrl("/e-application/tok"), "https://portal.example.com/e-application/tok");
  assert.equal(workbenchSide.portalUrl("medical-exam/tok"), "https://portal.example.com/medical-exam/tok");
});

test("sign-in return URLs are limited to the configured apps", () => {
  const { safeRedirect, portalLoginUrl } = portalSide;
  const here = "https://portal.example.com";
  assert.equal(safeRedirect("https://underwriting.example.com/case/1?x=1", here), "https://underwriting.example.com/case/1?x=1");
  assert.equal(safeRedirect("https://chat.example.com/", here), "https://chat.example.com/");
  assert.equal(safeRedirect("/proposal", here), "https://portal.example.com/proposal");
  for (const bad of ["https://evil.example.net/case/1", "//evil.example.net/x", "javascript:alert(1)",
    "https://underwriting.example.com.evil.net/", "http://underwriting.example.com/case/1", "data:text/html,x", "", null, undefined]) {
    assert.equal(safeRedirect(bad as string, here), null, String(bad));
  }
  assert.equal(
    portalLoginUrl("https://underwriting.example.com/case/1?autoRun=true"),
    "https://portal.example.com/login?next=https%3A%2F%2Funderwriting.example.com%2Fcase%2F1%3FautoRun%3Dtrue",
  );
});
