"use client";



import { endSso } from "@/lib/sso";
import { useI18n } from "@/lib/i18n/I18nProvider";
import Link from "next/link";

import { usePathname, useSearchParams } from "next/navigation";

import { useEffect, useRef, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { appHref } from "@/lib/appLinks";



// ── Icons ─────────────────────────────────────────────────────────────────────



function ShieldIcon() {

  return (

    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6" aria-hidden="true">

      <path fillRule="evenodd" d="M12 1.5a5.25 5.25 0 00-5.25 5.25v3a3 3 0 00-3 3v6.75a3 3 0 003 3h10.5a3 3 0 003-3v-6.75a3 3 0 00-3-3v-3c0-2.9-2.35-5.25-5.25-5.25zm3.75 8.25v-3a3.75 3.75 0 10-7.5 0v3h7.5z" clipRule="evenodd" />

    </svg>

  );

}



function ChevronIcon({ collapsed }: { collapsed: boolean }) {

  return (

    <svg

      xmlns="http://www.w3.org/2000/svg"

      viewBox="0 0 24 24"

      fill="none"

      stroke="currentColor"

      strokeWidth="2.5"

      strokeLinecap="round"

      strokeLinejoin="round"

      className={`w-4 h-4 transition-transform duration-300 rtl:-scale-x-100 ${collapsed ? "rotate-180" : ""}`}

    >

      <polyline points="15 18 9 12 15 6" />

    </svg>

  );

}



// ── Nav items ─────────────────────────────────────────────────────────────────



const NAV_ITEMS = [
  // ── 1. DASHBOARD ─────────────────────────────────────────────────────────
  {
    group: "Dashboard",
    links: [
      {
        href: "/",
        label: "Executive Overview",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
        ),
        badge: null,
        adminOnly: true,
      },
      {
        href: "/claims/dashboard",
        label: "Claims Dashboard",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
        ),
        badge: null,
        adminOnly: true,
      },
      {
        href: "/commissions",
        label: "Commission Dashboard",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" />
          </svg>
        ),
        badge: null,
        adminOnly: true,
      },
    ],
  },

  // ── 2. CUSTOMERS ─────────────────────────────────────────────────────────
  {
    group: "Customers",
    links: [
      {
        href: "/admin/leads",
        label: "Lead/Customer Acquisition",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 00-3-3.87" />
            <path d="M16 3.13a4 4 0 010 7.75" />
          </svg>
        ),
        badge: null,
        adminOnly: true,
        agentToo: true,   // an Agent (or Broker) adds leads here too, and takes them as far as a submitted proposal
      },

      {
        href: "/proposal",
        label: "Proposal",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
        ),
        badge: null,
      },
      {
        href: "/admin/policyholders",
        label: "Policy Holders",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
        ),
        badge: null,
        adminOnly: true,
      },
      {
        href: "/cases",
        label: "Applications",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </svg>
        ),
        badge: null,
      },

    ],
  },

  // ── 3. OPERATIONS ─────────────────────────────────────────────────────────
  {
    group: "Operations",
    links: [
      {
        href: "/plans",
        label: "Insurance Plans",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="9" y1="13" x2="15" y2="13" />
            <line x1="9" y1="17" x2="13" y2="17" />
          </svg>
        ),
        badge: null,
        adminOnly: true,
        agentToo: true,   // the same people who could open it from the Leads page: Admin, Agent and Broker
      },
      {
        href: "/admin/acquisition-sources",
        label: "Acquisition Sources",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
        ),
        badge: null,
        adminOnly: true,
      },
      // Customer Service and Request Management open from the profile menu at the foot of the sidebar, not the list.
      { href: "/customer-service", label: "Customer Service", icon: <ShieldIcon />, badge: null, inProfileMenu: true },
      { href: "/acr", label: "Confidential Reports (ACR)", icon: <ShieldIcon />, badge: null, hideForAdmin: true },
      {
        href: "/requests",
        label: "Request Management",
        inProfileMenu: true,
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5" aria-hidden="true">
            <rect x="5" y="4" width="14" height="17" rx="2" />
            <path d="M9 4V2h6v2M9 10h6M9 14l2 2 4-4" />
          </svg>
        ),
        badge: null,
      },
      {
        // Admins: the medical / financial underwriting overview in the portal.
        href: "/admin/underwriting",
        label: "Underwriting",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="M9 12l2 2 4-4" />
          </svg>
        ),
        badge: null,
        adminOnly: true,
      },
      {
        // Underwriters: their queues in the Underwriting Workbench.
        href: "/underwriting",
        label: "Underwriting",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="M9 12l2 2 4-4" />
          </svg>
        ),
        badge: null,
        hideForAdmin: true,
        subLinks: [
          { href: "/underwriting?tab=pre-underwriting", label: "Pre-Underwriting" },
          { href: "/post-underwriting", label: "Post-Underwriting Verification" },
        ],
      },
      {
        href: "/policy-issuance",
        label: "Policies",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <path d="M9 15l2 2 4-4" />
          </svg>
        ),
        badge: null,
      },
      {
        href: "/claims/register",
        label: "Claims",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
        ),
        badge: null,
      },
      {
        href: "/renewals",
        hidden: true, // hidden from the sidebar; the page still opens by URL
        label: "Renewals",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        ),
        badge: null,
      },
      {
        href: "/live-evaluation",
        hidden: true, // hidden from the sidebar; the page still opens by URL
        label: "Live Evaluation",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
        ),
        badge: null,
      },
      {
        href: "/case-summarizer",
        hidden: true, // hidden from the sidebar; the page still opens by URL
        label: "Application Summarizer",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="13" y2="17" />
          </svg>
        ),
        badge: null,
      },
      {
        href: "/assessments",
        hidden: true, // hidden from the sidebar; the page still opens by URL
        label: "Assessment History",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
          </svg>
        ),
        badge: null,
      },
    ],
  },

  // ── 4. ADMIN ──────────────────────────────────────────────────────────────
  {
    group: "Admin",
    links: [
      {href:"/admin/document-intelligence",label:"Document Intelligence",icon:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5"><path d="M6 3h9l4 4v14H6zM9 12h7M9 16h5" /></svg>,badge:null,adminOnly:true},
      {
        href: "/admin/rule-engine",
        label: "Rule Engine",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <rect x="3" y="3" width="6" height="6" rx="1" />
            <rect x="15" y="3" width="6" height="6" rx="1" />
            <rect x="9" y="15" width="6" height="6" rx="1" />
            <path d="M6 9v3a2 2 0 0 0 2 2h4" />
            <path d="M18 9v3a2 2 0 0 1-2 2h-4" />
            <path d="M12 14v1" />
          </svg>
        ),
        badge: "v1.0",
        adminOnly: true,
      },
      {
        href: "/admin/users",
        label: "User Management",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        ),
        badge: null,
        adminOnly: true,
      },
      {
        href: "/super-admin/tenants",
        label: "Tenant Management",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        ),
        badge: null,
        superAdminOnly: true,
      },
      {
        href: "/super-admin/admins",
        label: "Admin Management",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21c0-4 3.5-7 8-7s8 3 8 7" />
            <path d="M18.5 3.5l1.5 1.5-3 3-1.5-1.5z" />
          </svg>
        ),
        badge: null,
        superAdminOnly: true,
      },
      {
        href: "/super-admin/branches",
        label: "Branch Management",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M3 21h18" />
            <path d="M5 21V7l7-4 7 4v14" />
            <path d="M9 21v-6h6v6" />
          </svg>
        ),
        badge: null,
        superAdminOnly: true,
      },
      {
        href: "/super-admin/roles",
        label: "Role Management",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5l8-3z" />
            <path d="M9 12l2 2 4-4" />
          </svg>
        ),
        badge: null,
        superAdminOnly: true,
      },
      {
        href: "/super-admin/tokens",
        label: "Token Economy",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4l3 3" />
          </svg>
        ),
        badge: null,
        superAdminOnly: true,
      },
      {
        href: "/super-admin/document-forgery",
        label: "Document Forgery Detection",
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5"><path d="M6 3h9l4 4v14H6zM9 12h7M9 16h5" /></svg>,
        badge: null,
        superAdminOnly: true,
      },
      {
        href: "/super-admin/ai-agents",
        label: "AI Agents",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <rect x="7" y="2" width="10" height="7" rx="2" />
            <path d="M12 9v5M5 14h14M5 14v4M19 14v4" />
            <rect x="2" y="18" width="6" height="4" rx="1" /><rect x="16" y="18" width="6" height="4" rx="1" />
          </svg>
        ),
        badge: null,
        superAdminOnly: true,
      },
      {
        href: "/super-admin/llm-config",
        label: "LLM Configuration",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <path d="M9 9h6v6H9z" />
            <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
          </svg>
        ),
        badge: null,
        superAdminOnly: true,
      },
      {
        href: "/super-admin/datasets",
        label: "Golden Datasets",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <ellipse cx="12" cy="5" rx="8" ry="3" />
            <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
            <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
          </svg>
        ),
        badge: null,
        superAdminOnly: true,
      },
      {
        // Platform administrator only: the audit trail spans every tenant's chain.
        href: "#security-compliance",
        label: "Security & Compliance",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="M9 12l2 2 4-4" />
          </svg>
        ),
        badge: null,
        superAdminOnly: true,
        subLinks: [
          { href: "/admin/audit-trail", label: "Audit Trail" },
        ],
      },
      {
        href: "/profile",
        label: "Profile",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        ),
        badge: null,
      },
    ],
  },

  // ── 5. FINANCES ───────────────────────────────────────────────────────────
  {
    group: "Finances",
    links: [
      {
        href: "#comm-admin",
        label: "Commission Admin",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" />
          </svg>
        ),
        badge: null,
        subLinks: [
          { href: "/commissions/types", label: "Commission Types" },
          { href: "/commissions/payees", label: "Roles" },
          { href: "/commissions/bonuses", label: "Bonuses" },
          { href: "/commissions/calculator", label: "Calculator" },
        ],
      },
      {
        href: "#comm-ops",
        hidden: true, // hidden from the sidebar; the page still opens by URL
        label: "Commission Ops",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
        ),
        badge: null,
        subLinks: [
          { href: "/commission-ops", label: "Ops Dashboard" },
          { href: "/commission-ops/ledger", label: "Accrual Feed" },
          { href: "/commission-ops/statements", label: "Payee Statements" },
        ],
      },
      {
        href: "/treasury",
        hidden: true, // hidden from the sidebar; the page still opens by URL
        label: "Disbursement",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <rect x="2" y="5" width="20" height="14" rx="2" />
            <line x1="2" y1="10" x2="22" y2="10" />
          </svg>
        ),
        badge: null,
        subLinks: [
          { href: "/treasury/runs", label: "Batch Payout Runs" },
          { href: "/treasury/settlement", label: "Payment Settlement" },
          { href: "/treasury/holdbacks", label: "Holdbacks & Lien" },
        ],
      },
      {
        href: "/risk",
        hidden: true, // hidden from the sidebar; the page still opens by URL
        label: "Compliance",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
        ),
        badge: null,
        subLinks: [
          { href: "/risk/clawbacks", label: "Clawback Engine" },
          { href: "/risk/tax", label: "FBR Tax Regimes" },
          { href: "/risk/secp", label: "SECP Expense Cap" },
        ],
      },
    ],
  },
] as const;



// ── Component ─────────────────────────────────────────────────────────────────




/**
 * Which sidebar entry is lit for this URL. A page with sub-links (Underwriting, Policy Issuance, Claims...)
 * lights the exact sub-link the user is on, matched by path and query (?tab=...), so arriving at
 * Policy issuance and servicing share one Policies entry.
 * A page opened without a tab falls back to the first sub-link for that path, which is the tab the page
 * itself opens on. Anything else lights the plain link for the path.
 */
// Pages that belong to a section without being one of its sub-links: the case workspace is where
// underwriting actually happens, a policy's post-issuance page is part of the Post-Issuance queue, and so on.
const SECTION_PAGES: { prefix: string; href: string }[] = [
  { prefix: "/case/", href: "/underwriting?tab=pre-underwriting" },
  { prefix: "/post-issuance/", href: "/policy-issuance" },
  { prefix: "/claims/", href: "/claims/register" },
];

function activeSidebarHref(pathname: string, searchParams: { get(name: string): string | null }): string {
  if (pathname === "/finance") {
    const view = searchParams.get("view");
    return ["payouts", "history", "reconciliation"].includes(view ?? "") ? `/finance?view=${view}` : "/finance";
  }
  const section = SECTION_PAGES.find((p) => pathname.startsWith(p.prefix) && !pathname.startsWith("/claims/dashboard") && !pathname.startsWith("/claims/register"));
  if (section) return section.href;
  let best: { href: string; score: number } | null = null;
  let firstForPath: string | null = null;
  for (const group of NAV_ITEMS as unknown as any[]) {
    for (const link of group.links) {
      for (const sub of link.subLinks ?? []) {
        const [subPath, subQuery = ""] = String(sub.href).split("?");
        if (subPath !== pathname) continue;
        if (firstForPath === null) firstForPath = sub.href;
        const wanted = Array.from(new URLSearchParams(subQuery).entries());
        if (wanted.length === 0 || !wanted.every(([k, v]) => searchParams.get(k) === v)) continue;
        if (!best || wanted.length > best.score) best = { href: sub.href, score: wanted.length };
      }
    }
  }
  if (best) return best.href;
  // On a path whose sub-links are tabs but with no tab given, the page opens on the first one.
  const tabbed = firstForPath && String(firstForPath).includes("?");
  if (tabbed && !searchParams.get("tab")) return firstForPath as string;
  return pathname;
}

export function Sidebar() {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!profileMenuOpen) return;
    const onPointer = (e: MouseEvent) => { if (!profileMenuRef.current?.contains(e.target as Node)) setProfileMenuOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setProfileMenuOpen(false); };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [profileMenuOpen]);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [activeHref, setActiveHref] = useState(pathname);
  const [userName, setUserName] = useState("Saira Reviewer");
  const [userEmail, setUserEmail] = useState("Senior Underwriter");
  const [userRole, setUserRole] = useState("");
  const [navMode, setNavMode] = useState<"all" | "working">("all");
  const [expandedMenus, setExpandedMenus] = useState<Record<string, boolean>>({});

  // Drag and Drop state
  const initialOrder = NAV_ITEMS.map((g: any) => ({ group: g.group, links: g.links.map((l: any) => l.href) }));
  const [navOrder, setNavOrder] = useState(initialOrder);
  const [draggedItem, setDraggedItem] = useState<{ groupIndex: number, linkIndex: number } | null>(null);
  const [draggedOverItem, setDraggedOverItem] = useState<{ groupIndex: number, linkIndex: number } | null>(null);

  useEffect(() => {
    const lit = activeSidebarHref(pathname, searchParams);
    setActiveHref(lit);

    NAV_ITEMS.forEach((g: any) => {
      g.links.forEach((l: any) => {
        if (l.subLinks && (l.subLinks.some((sub: any) => sub.href === lit) || l.subLinks.some((sub: any) => pathname.startsWith(sub.href.split("?")[0])))) {
          setExpandedMenus(prev => ({ ...prev, [l.href]: true }));
        }
      });
    });
  }, [pathname, searchParams]);

  useEffect(() => {
    const storedName = localStorage.getItem("user_name");
    const storedEmail = localStorage.getItem("user_email");
    const storedRole = localStorage.getItem("user_role");
    const savedMode = localStorage.getItem("demo_nav_mode");
    const savedOrder = localStorage.getItem("sidebar_nav_order");

    if (storedName) setUserName(storedName);
    if (storedEmail) setUserEmail(storedEmail);
    if (storedRole) setUserRole(storedRole);
    if (savedMode === "working") setNavMode("working");

    if (savedOrder) {
      try {
        const parsed = JSON.parse(savedOrder);
        const validGroupNames = new Set(NAV_ITEMS.map((g: any) => g.group).filter(Boolean));

        // Filter out obsolete groups that no longer exist in NAV_ITEMS
        const validParsed = Array.isArray(parsed)
          ? parsed.filter((g: any) => g.group && validGroupNames.has(g.group))
          : [];

        // Append any groups added to NAV_ITEMS since order was saved
        const savedGroups = new Set(validParsed.map((g: any) => g.group));
        NAV_ITEMS.forEach((g: any, gi: number) => {
          if (g.group && !savedGroups.has(g.group)) {
            // After the section that precedes it in NAV_ITEMS (so a new section lands where it was designed to,
            // even for someone who has re-ordered the menu); with no such neighbour it goes at the end.
            let insertAt = validParsed.length;
            for (let k = gi - 1; k >= 0; k--) {
              const pos = validParsed.findIndex((x: any) => x.group === (NAV_ITEMS as unknown as any[])[k].group);
              if (pos >= 0) { insertAt = pos + 1; break; }
            }
            validParsed.splice(insertAt, 0, { group: g.group, links: g.links.map((l: any) => l.href) });
            savedGroups.add(g.group);
          }
        });

        // Clean up any links inside saved groups that now belong to a different group in NAV_ITEMS
        validParsed.forEach((groupObj: any) => {
          groupObj.links = groupObj.links.filter((href: string) => {
            const currentOrigGroup = NAV_ITEMS.find((g: any) => g.links.some((l: any) => l.href === href));
            return !currentOrigGroup || currentOrigGroup.group === groupObj.group;
          });
        });

        // Merge any remaining new links into their respective target groups
        const allSavedHrefs = new Set(validParsed.flatMap((g: any) => g.links));
        const missingLinks = NAV_ITEMS.flatMap((g: any) => g.links).filter((l: any) => !allSavedHrefs.has(l.href));
        if (missingLinks.length > 0 && validParsed.length > 0) {
          missingLinks.forEach((l: any) => {
            const origGroup = NAV_ITEMS.find((g: any) => g.links.some((link: any) => link.href === l.href));
            const targetGroup = validParsed.find((g: any) => g.group === origGroup?.group) || validParsed[0];
            if (targetGroup && !targetGroup.links.includes(l.href)) {
              // Slot it in after the link that precedes it in NAV_ITEMS (so a new item lands where it was designed
              // to, even for someone who has re-ordered the menu); with no such neighbour it goes at the end.
              const original: string[] = (origGroup?.links ?? []).map((link: any) => link.href);
              let insertAt = targetGroup.links.length;
              for (let k = original.indexOf(l.href) - 1; k >= 0; k--) {
                const pos = targetGroup.links.indexOf(original[k]);
                if (pos >= 0) { insertAt = pos + 1; break; }
              }
              targetGroup.links.splice(insertAt, 0, l.href);
            }
          });
        }
        setNavOrder(validParsed);
        localStorage.setItem("sidebar_nav_order", JSON.stringify(validParsed));
      } catch (e) { }
    }
  }, []);

  const resetNavOrder = () => {
    setNavOrder(initialOrder);
    localStorage.removeItem("sidebar_nav_order");
  };

  const handleDragStart = (e: React.DragEvent, groupIndex: number, linkIndex: number) => {
    setDraggedItem({ groupIndex, linkIndex });
    // e.dataTransfer.effectAllowed = 'move'; // Causing visual issues in some browsers without specific data
  };

  const handleDragEnter = (e: React.DragEvent, groupIndex: number, linkIndex: number) => {
    e.preventDefault();
    if (!draggedItem) return;
    if (draggedItem.groupIndex === groupIndex && draggedItem.linkIndex === linkIndex) return;

    setNavOrder((prevOrder) => {
      const newOrder = JSON.parse(JSON.stringify(prevOrder));
      const itemToMove = newOrder[draggedItem.groupIndex].links[draggedItem.linkIndex];

      // Remove from old
      newOrder[draggedItem.groupIndex].links.splice(draggedItem.linkIndex, 1);
      // Insert at new
      newOrder[groupIndex].links.splice(linkIndex, 0, itemToMove);

      setDraggedItem({ groupIndex, linkIndex });
      return newOrder;
    });
  };

  const handleDragEnd = () => {
    setDraggedItem(null);
    setDraggedOverItem(null);
    localStorage.setItem("sidebar_nav_order", JSON.stringify(navOrder));
  };

  // Reconstruct display groups using navOrder and NAV_ITEMS mapping
  const allLinksMap = new Map<string, any>();
  NAV_ITEMS.forEach((g: any) => g.links.forEach((l: any) => allLinksMap.set(l.href, l)));

  const reconstructedNavGroups = navOrder.map(g => ({
    group: g.group,
    links: g.links.map((href: string) => allLinksMap.get(href)).filter(Boolean)
  }));

  const workingHrefs = ["/customer-service", "/acr", "/profile", "/cases", "/requests", "/artifacts", "/live-evaluation", "/case-summarizer", "/assessments", "/underwriting", "/admin/underwriting", "/admin/users", "/admin/leads", "/admin/policyholders", "/plans", "/financial", "/claims", "/claims/dashboard", "/claims/register"];
  const superAdminHrefs = ["/super-admin/document-forgery", "/super-admin/tenants", "/super-admin/admins", "/super-admin/branches", "/super-admin/roles", "/super-admin/tokens", "/super-admin/ai-agents", "/super-admin/llm-config", "/super-admin/datasets", "#security-compliance"];

  const financeIcon = (path: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d={path}/></svg>;
  const financeLinks = [
    { href: "/finance", label: "Payments dashboard", icon: financeIcon("M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z"), badge: null },
    { href: "/finance?view=payouts", label: "Awaiting payout", icon: financeIcon("M3 5h18v14H3z M3 9h18 M7 14h3 M15 14h3"), badge: null },
    { href: "/finance?view=reconciliation", label: "Reconciliation", icon: financeIcon("M9 11l3 3 8-8 M20 12v8H4V4h10"), badge: null },
    { href: "/finance?view=history", label: "Payment history", icon: financeIcon("M3 11a9 9 0 1 1 2.6 7 M3 4v7h7 M12 7v5l3 2"), badge: null },
    { href: "/profile", label: "Profile", icon: financeIcon("M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2"), badge: null },
  ];
  const displayGroups = (userRole === "Finance" ? [{ group: "Finance", links: financeLinks }] : userRole === "SuperAdmin"
    ? [
      {
        group: "PLATFORM ADMINISTRATION",
        links: reconstructedNavGroups.flatMap((g) => g.links).filter((link: any) => superAdminHrefs.includes(link.href)),
      },
    ]
    : navMode === "working"
      ? [
        {
          group: "WORKING MODULES",
          links: reconstructedNavGroups.flatMap((g) => g.links).filter((link: any) => workingHrefs.includes(link.href)),
        },
      ]
      : reconstructedNavGroups) as any;

  // We only allow drag and drop when displaying the full standard nav (not working mode or super admin flat lists, to simplify logic)
  const isDragEnabled = userRole !== "Finance" && userRole !== "SuperAdmin" && navMode !== "working";

  // Who may see a link: the same rules for the list and for the profile menu.
  const canSeeLink = (link: any) => {
    if (userRole === "Finance") return financeLinks.some(item => item.href === link.href);
    if (["Medical Underwriter", "Financial Underwriter"].includes(userRole ?? "") && !["/underwriting", "/profile"].includes(link.href)) return false;
    if (link.hidden) return false;
    if (link.hideForAdmin && userRole === "Admin") return false;
    if (link.adminOnly && userRole !== "Admin" && !(link.agentToo && (userRole === "Agent" || userRole === "Broker")) && !(link.superAdminToo && userRole === "SuperAdmin")) return false;
    if (link.superAdminOnly && userRole !== "SuperAdmin") return false;
    return true;
  };
  const profileMenuLinks = (NAV_ITEMS as unknown as any[]).flatMap((g) => g.links).filter((l: any) => l.inProfileMenu && canSeeLink(l));

  return (
    <aside
      className={`
        sidebar-shell flex-shrink-0 flex flex-col
        bg-white border-e border-slate-200
        transition-all duration-300 ease-in-out overflow-x-hidden
        ${collapsed ? "w-[72px]" : "w-64"}
        h-screen relative z-40
      `}
    >
      {/* ── Brand ─────────────────────────────────────────────────────────── */}
      <div className={`flex items-center border-b border-slate-100 flex-shrink-0 ${collapsed ? "flex-col justify-center py-4 gap-4" : "justify-between h-16 px-4"}`}>
        <Link
          href={
            userRole === "Admin"
              ? "/"
              : userRole === "SuperAdmin"
              ? "/super-admin/tenants"
              : userRole === "Agent" || userRole === "Broker"
              ? "/proposal"
              : "/cases"
          }
          className="flex items-center overflow-hidden min-w-0"
          title={t("sidebar.brand")}
        >
          {/* The product logo, the same one the Automation Chat uses: the full wordmark, or just the mark when collapsed. */}
          {collapsed ? (
            <img src="/logo-mark.png" alt="GetInsuredAI" className="h-8 w-auto object-contain flex-shrink-0" />
          ) : (
            <img src="/logo-full.png" alt="GetInsuredAI, powered by Rizviz" className="w-[168px] max-w-full h-auto object-contain" />
          )}
        </Link>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors flex-shrink-0"
          aria-label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
        >
          <ChevronIcon collapsed={collapsed} />
        </button>
      </div>

      {/* ── Nav ───────────────────────────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-5" aria-label={t("sidebar.navLabel")}>
        {displayGroups.map((group: any, gIndex: number) => {
          const visibleLinks = group.links.filter((link: any) => !link.inProfileMenu && canSeeLink(link));
          if (visibleLinks.length === 0) return null;

          return (
            <div key={group.group} className={collapsed && gIndex > 0 ? "pt-5 border-t border-slate-200 w-full" : ""}>
              {!collapsed && (
                <p className="px-2 mb-1.5 text-[9px] font-bold uppercase tracking-[0.15em] text-slate-600">
                  {t(`nav.${group.group}`)}
                </p>
              )}
              <div className="space-y-0.5">
                {visibleLinks.map((link: any, lIndex: number) => {
                  const specialist = ["Medical Underwriter", "Financial Underwriter"].includes(userRole ?? "");
                  const hasSubLinks = !!link.subLinks && !specialist;
                  const isActive = activeHref === link.href || (link.subLinks && link.subLinks.some((sub: any) => activeHref === sub.href));
                  const isDraggingThis = draggedItem?.groupIndex === gIndex && draggedItem?.linkIndex === lIndex;

                  const toggleSubmenu = (e: React.MouseEvent) => {
                    e.preventDefault();
                    setExpandedMenus(prev => ({ ...prev, [link.href]: !prev[link.href] }));
                  };

                  return (
                    <div
                      key={link.href}
                      draggable={isDragEnabled}
                      onDragStart={(e) => handleDragStart(e, gIndex, lIndex)}
                      onDragEnter={(e) => isDragEnabled && handleDragEnter(e, gIndex, lIndex)}
                      onDragEnd={handleDragEnd}
                      onDragOver={(e) => e.preventDefault()}
                      className={`relative group ${isDraggingThis ? "opacity-50 border border-dashed border-slate-300 rounded-xl" : ""}`}
                    >
                      <Link
                        href={hasSubLinks ? "#" : appHref(link.href)}
                        data-tour={link.href}
                        title={collapsed ? t(`nav.${link.label}`) : undefined}
                        onClick={(e) => {
                          if (hasSubLinks) toggleSubmenu(e);
                          else setActiveHref(link.href);
                        }}
                        className={`
                          sidebar-link flex items-center transition-all duration-150 text-[13px]
                          ${collapsed ? "w-11 h-11 justify-center rounded-xl mx-auto p-0" : "gap-2.5 px-3 py-2.5 rounded-xl mx-2"}
                          ${isActive
                            ? "bg-blue-50 text-slate-600 font-bold shadow-sm ring-1 ring-blue-100/50"
                            : "text-slate-600 font-medium hover:text-slate-900 hover:bg-slate-50"
                          }
                        `}
                      >
                        {isDragEnabled && !collapsed && (
                          <div className="cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500 me-1 flex-shrink-0 transition-colors">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                              <circle cx="9" cy="5" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="9" cy="19" r="1" />
                              <circle cx="15" cy="5" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="19" r="1" />
                            </svg>
                          </div>
                        )}
                        <span className={`flex-shrink-0 transition-colors ${isActive ? "text-slate-500" : "text-slate-400 group-hover:text-slate-600"} ${isDragEnabled && !collapsed ? "" : ""}`}>
                          {link.icon}
                        </span>
                        {!collapsed && (
                          <span className="flex-1 truncate">{t(`nav.${link.label}`)}</span>
                        )}
                        {!collapsed && link.badge && (
                          <span className={`
                            text-[10px] font-bold px-2 py-0.5 rounded-full flex-shrink-0 ms-auto
                            ${isActive ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-500"}
                          `}>
                            {link.badge}
                          </span>
                        )}
                        {!collapsed && hasSubLinks && (
                          <svg
                            className={`ms-auto w-4 h-4 transition-transform duration-200 text-slate-400 ${expandedMenus[link.href] ? "rotate-180" : ""}`}
                            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        )}
                        {collapsed && link.badge && (
                          <span className="absolute top-0.5 end-0.5 w-1.5 h-1.5 rounded-full bg-blue-500" />
                        )}
                      </Link>

                      {/* Sub-links Rendering */}
                      {!collapsed && hasSubLinks && expandedMenus[link.href] && (
                        <div className="mt-1 mb-2 ms-[36px] relative space-y-1 animate-in slide-in-from-top-1 fade-in duration-200 me-2">
                          {/* Continuous vertical line for the tree */}
                          <div className="absolute start-[9px] top-2 bottom-3.5 w-[2px] bg-slate-100 rounded-full" />

                          {link.subLinks.map((sub: any) => {
                            const isSubActive = activeHref === sub.href;
                            return (
                              <Link
                                key={sub.href}
                                href={appHref(sub.href)}
                                onClick={() => setActiveHref(sub.href)}
                                className={`
                                  group relative flex items-center ps-7 pe-3 py-1.5 text-[12px] rounded-lg transition-all duration-200
                                  ${isSubActive
                                    ? "text-slate-600 font-bold bg-blue-50/50 ring-1 ring-blue-100/50 shadow-sm"
                                    : "text-slate-500 font-medium hover:text-slate-900 hover:bg-slate-50"}
                                `}
                              >
                                {/* Active / Hover Dot */}
                                <div
                                  className={`absolute start-[6.5px] w-[7px] h-[7px] rounded-full transition-all duration-200 z-10
                                    ${isSubActive
                                      ? "bg-blue-500 ring-4 ring-blue-50"
                                      : "bg-slate-200 ring-2 ring-white group-hover:bg-slate-400 group-hover:scale-125"
                                    }
                                  `}
                                />

                                <span className="truncate tracking-wide">{t(`nav.${sub.label}`)}</span>
                              </Link>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {!collapsed && isDragEnabled && (
          <div className="px-4 py-4 mt-8 border-t border-slate-100">
            <button
              onClick={resetNavOrder}
              className="w-full py-2 text-[10px] font-bold text-slate-400 hover:text-slate-600 uppercase tracking-wider bg-slate-50 hover:bg-slate-100 rounded-lg transition-colors border border-slate-200"
            >
              {t("sidebar.resetOrder")}
            </button>
          </div>
        )}
      </nav>

      {/* ── User menu: Customer Service, Request Management, Profile, Sign out ── */}
      <div ref={profileMenuRef} className="relative p-3 border-t border-slate-100 bg-slate-50 flex-shrink-0">
        {profileMenuOpen && (
          <div
            role="menu"
            className={`absolute z-50 w-60 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg shadow-slate-900/10 ${collapsed ? "left-full bottom-3 ml-2" : "left-3 right-3 bottom-full mb-2 w-auto"}`}
          >
            <div className="px-2.5 py-2 border-b border-slate-100 mb-1">
              <p className="text-sm font-semibold text-slate-900 truncate">{userName || "—"}</p>
              <p className="text-[11px] text-slate-500 truncate">{userEmail}</p>
            </div>
            {profileMenuLinks.map((link: any) => (
              <a
                key={link.href}
                href={appHref(link.href)}
                role="menuitem"
                onClick={() => setProfileMenuOpen(false)}
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-slate-700 hover:bg-slate-50"
              >
                <span className="text-slate-400 [&_svg]:w-4 [&_svg]:h-4">{link.icon}</span>
                {tx(link.label)}
              </a>
            ))}
            {profileMenuLinks.length > 0 && <div className="my-1 h-px bg-slate-100" />}
            <Link
              href="/profile"
              role="menuitem"
              onClick={() => setProfileMenuOpen(false)}
              className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-slate-700 hover:bg-slate-50"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-slate-400"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
              {t("sidebar.profile")}
            </Link>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                localStorage.clear();
                endSso().finally(() => window.location.replace("/login"));
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-rose-600 hover:bg-rose-50"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
              {t("sidebar.logout")}
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => setProfileMenuOpen(!profileMenuOpen)}
          aria-haspopup="menu"
          aria-expanded={profileMenuOpen}
          title={t("sidebar.profile")}
          className={`flex w-full items-center rounded-xl p-2 text-left transition-colors ${profileMenuOpen ? "bg-white shadow-sm" : "hover:bg-white"} ${collapsed ? "justify-center" : "gap-3"}`}
        >
          <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-sm shadow-sm flex-shrink-0 ring-2 ring-white">
            {userName.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() || tx("SR")}
          </div>
          {!collapsed && (
            <>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-slate-900 truncate">{userName}</p>
                <p className="text-[10px] text-slate-500 truncate">{userRole || userEmail}</p>
              </div>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`w-4 h-4 text-slate-400 transition-transform ${profileMenuOpen ? "" : "rotate-180"}`}><polyline points="6 9 12 15 18 9" /></svg>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
