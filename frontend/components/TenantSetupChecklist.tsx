"use client";

import Link from "next/link";

// Tenant onboarding is three steps across three pages: create the tenant, give it a
// branch (every Admin and staff user must belong to one), then create its first
// Admin, who receives login credentials by email. This component spells that out.

export interface TenantSetupStatus {
  tenant_id: string;
  branch_count: number;
  admin_count: number;
  plan_count?: number;
}

export const branchesHref = (tenantId: string, openForm = false) =>
  `/super-admin/branches?tenantId=${tenantId}${openForm ? "&new=1" : ""}`;
export const adminsHref = (tenantId: string, openForm = false) =>
  `/super-admin/admins?tenantId=${tenantId}${openForm ? "&new=1" : ""}`;

/** Steps completed out of 3 (the tenant itself always counts as done). */
export const setupProgress = (s?: TenantSetupStatus) =>
  1 + (s && s.branch_count > 0 ? 1 : 0) + (s && s.admin_count > 0 ? 1 : 0);

/** The next action for an unfinished tenant, or null once it's ready. */
export function nextSetupStep(tenantId: string, s?: TenantSetupStatus) {
  if (!s || s.branch_count === 0) return { label: "Add branch", href: branchesHref(tenantId, true) };
  if (s.admin_count === 0) return { label: "Create admin", href: adminsHref(tenantId, true) };
  return null;
}

function StepIcon({ state, n }: { state: "done" | "current" | "todo"; n: number }) {
  if (state === "done") {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="3" stroke="currentColor" className="h-3.5 w-3.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </span>
    );
  }
  return (
    <span
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-bold ${
        state === "current" ? "border-blue-600 text-blue-600" : "border-slate-300 text-slate-400"
      }`}
    >
      {n}
    </span>
  );
}

export default function TenantSetupChecklist({
  tenantId,
  tenantName,
  status,
}: {
  tenantId: string;
  tenantName: string;
  status?: TenantSetupStatus;
}) {
  const hasBranch = !!status && status.branch_count > 0;
  const hasAdmin = !!status && status.admin_count > 0;

  const steps = [
    {
      title: "Create the tenant",
      detail: `${tenantName} is registered on the platform.`,
      done: true,
    },
    {
      title: "Add a branch",
      detail: hasBranch
        ? `${status!.branch_count} branch${status!.branch_count === 1 ? "" : "es"} added.`
        : "Admins and staff must belong to a branch — start with the head office.",
      done: hasBranch,
      action: { label: "Add branch", href: branchesHref(tenantId, true) },
    },
    {
      title: "Create the first Admin",
      detail: hasAdmin
        ? `${status!.admin_count} Admin${status!.admin_count === 1 ? "" : "s"} provisioned.`
        : "The Admin receives login credentials by email and manages the tenant's users from there.",
      done: hasAdmin,
      action: { label: "Create admin", href: adminsHref(tenantId, true) },
      blocked: !hasBranch,
    },
  ];
  const currentIndex = steps.findIndex((s) => !s.done);

  return (
    <ol className="space-y-3">
      {steps.map((step, i) => {
        const state = step.done ? "done" : i === currentIndex ? "current" : "todo";
        return (
          <li key={step.title} className="flex items-start gap-3">
            <StepIcon state={state} n={i + 1} />
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-semibold ${state === "todo" ? "text-slate-400" : "text-slate-800"}`}>{step.title}</p>
              <p className="text-xs text-slate-500 mt-0.5">{step.detail}</p>
            </div>
            {!step.done && step.action && (
              step.blocked ? (
                <span className="text-[11px] text-slate-400 whitespace-nowrap pt-0.5">Needs a branch first</span>
              ) : (
                <Link
                  href={step.action.href}
                  className="shrink-0 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
                >
                  {step.action.label} →
                </Link>
              )
            )}
          </li>
        );
      })}
    </ol>
  );
}
