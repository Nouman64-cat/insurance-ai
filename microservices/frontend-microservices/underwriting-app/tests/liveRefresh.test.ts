// Which live events make the underwriting screens re-read their data (lib/liveRefresh.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { affectsUnderwriting } from "../lib/liveRefresh.ts";

const evt = (event_type: string, extra: Record<string, unknown> = {}) =>
  ({ type: "case_event", event_id: "e", timestamp: "", case_id: null, event_type, ...extra }) as any;

test("case events always refresh", () => {
  for (const type of ["EApplicationSubmitted", "ACRSubmitted", "ACRRequested", "MedicalExamCompleted", "VerificationCompleted", "RequirementsDetermined"]) {
    assert.equal(affectsUnderwriting(evt(type, { case_id: "c1" })), true, type);
  }
});

test("writes to underwriting data refresh, writes elsewhere in the tenant don't", () => {
  for (const resource of ["cases", "customers", "policies", "compliance", "requirements", "artifacts", "families", "organizations", "acr-requests", "demo", "something-new"]) {
    assert.equal(affectsUnderwriting(evt("DataChanged", { detail: { resource, method: "POST" } })), true, resource);
  }
  for (const resource of ["claims", "commissions", "rules", "users", "branches", "insurance-plans", "acquisition-sources"]) {
    assert.equal(affectsUnderwriting(evt("DataChanged", { detail: { resource, method: "POST" } })), false, resource);
  }
});

test("other events without a case are ignored", () => {
  assert.equal(affectsUnderwriting(evt("Heartbeat")), false);
});
