"use client";



import Link from "next/link";

import { usePathname, useSearchParams } from "next/navigation";

import { useEffect, useState } from "react";



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

      className={`w-4 h-4 transition-transform duration-300 ${collapsed ? "rotate-180" : ""}`}

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
      },
    ],
  },

  // ── 2. CUSTOMERS ─────────────────────────────────────────────────────────
  {
    group: "Customers",
    links: [
      {
        href: "/admin/leads",
        label: "Leads",
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
        label: "Cases",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </svg>
        ),
        badge: "7",
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
    ],
  },

  // ── 3. OPERATIONS ─────────────────────────────────────────────────────────
  {
    group: "Operations",
    links: [
      {
        href: "/underwriting",
        label: "Underwriting",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="M9 12l2 2 4-4" />
          </svg>
        ),
        badge: null,
        subLinks: [
          { href: "/underwriting?tab=pre-underwriting", label: "Pre-Underwriting" },
          { href: "/underwriting?tab=risk-engine", label: "Risk Engine & OCR OPS" },
          { href: "/post-underwriting", label: "Post-Underwriting Verification" },
        ],
      },
      {
        href: "/policy-issuance",
        label: "Policy Issuance",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <path d="M9 15l2 2 4-4" />
          </svg>
        ),
        badge: null,
        subLinks: [
          { href: "/policy-issuance?tab=queue", label: "Pre-Issuance Queue" },
          { href: "/policy-issuance?tab=active", label: "Post-Issuance Queue" },
        ],
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
        subLinks: [
          { href: "/claims/register", label: "Claims Register" },
        ],
      },
      {
        href: "/renewals",
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
        label: "Case Summarizer",
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



export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
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
    const tab = searchParams.get("tab");
    if (pathname === "/underwriting" && tab) {
      setActiveHref(`${pathname}?tab=${tab}`);
    } else {
      setActiveHref(pathname);
    }

    NAV_ITEMS.forEach((g: any) => {
      g.links.forEach((l: any) => {
        if (l.subLinks && l.subLinks.some((sub: any) => pathname.startsWith(sub.href.split("?")[0]))) {
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
        NAV_ITEMS.forEach((g: any) => {
          if (g.group && !savedGroups.has(g.group)) {
            validParsed.push({ group: g.group, links: g.links.map((l: any) => l.href) });
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
              targetGroup.links.push(l.href);
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

  const workingHrefs = ["/profile", "/cases", "/artifacts", "/live-evaluation", "/case-summarizer", "/assessments", "/underwriting", "/admin/users", "/admin/leads", "/admin/policyholders", "/financial", "/claims", "/claims/dashboard", "/claims/register"];
  const superAdminHrefs = ["/super-admin/tenants", "/super-admin/admins", "/super-admin/branches", "/super-admin/tokens"];

  const displayGroups = (userRole === "SuperAdmin"
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
  const isDragEnabled = userRole !== "SuperAdmin" && navMode !== "working";

  return (
    <aside
      className={`
        sidebar-shell flex-shrink-0 flex flex-col
        bg-white border-r border-slate-200
        transition-all duration-300 ease-in-out overflow-x-hidden
        ${collapsed ? "w-[72px]" : "w-64"}
        h-screen relative z-40
      `}
    >
      {/* ── Brand ─────────────────────────────────────────────────────────── */}
      <div className={`flex items-center border-b border-slate-100 flex-shrink-0 ${collapsed ? "flex-col justify-center py-4 gap-4" : "justify-between h-16 px-4"}`}>
        <Link href="/" className="flex items-center gap-2.5 overflow-hidden">
          <span className="text-blue-600 flex-shrink-0">
            <ShieldIcon />
          </span>
          {!collapsed && (
            <div className="flex flex-col justify-center">
              <span className="text-slate-900 font-bold text-[16px] tracking-tight whitespace-nowrap leading-tight">
                Life Insurance
              </span>
              <span className="text-blue-500 font-medium text-[11px] whitespace-nowrap leading-tight">
                AI powered solutions
              </span>
            </div>
          )}
        </Link>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors flex-shrink-0"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <ChevronIcon collapsed={collapsed} />
        </button>
      </div>

      {/* ── Nav ───────────────────────────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-5" aria-label="Sidebar navigation">
        {displayGroups.map((group: any, gIndex: number) => {
          const visibleLinks = group.links.filter((link: any) => {
            if (link.adminOnly && userRole !== "Admin") return false;
            if (link.superAdminOnly && userRole !== "SuperAdmin") return false;
            return true;
          });
          if (visibleLinks.length === 0) return null;

          return (
            <div key={group.group} className={collapsed && gIndex > 0 ? "pt-5 border-t border-slate-200 w-full" : ""}>
              {!collapsed && (
                <p className="px-2 mb-1.5 text-[9px] font-bold uppercase tracking-[0.15em] text-slate-600">
                  {group.group}
                </p>
              )}
              <div className="space-y-0.5">
                {visibleLinks.map((link: any, lIndex: number) => {
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
                        href={link.subLinks ? "#" : link.href}
                        title={collapsed ? link.label : undefined}
                        onClick={(e) => {
                          if (link.subLinks) toggleSubmenu(e);
                          else setActiveHref(link.href);
                        }}
                        className={`
                          sidebar-link flex items-center transition-all duration-150 text-[13px]
                          ${collapsed ? "w-11 h-11 justify-center rounded-xl mx-auto p-0" : "gap-2.5 px-3 py-2.5 rounded-xl mx-2"}
                          ${isActive
                            ? "bg-blue-50 text-blue-700 font-bold shadow-sm ring-1 ring-blue-100/50"
                            : "text-slate-600 font-medium hover:text-slate-900 hover:bg-slate-50"
                          }
                        `}
                      >
                        {isDragEnabled && !collapsed && (
                          <div className="cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500 mr-1 flex-shrink-0 transition-colors">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                              <circle cx="9" cy="5" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="9" cy="19" r="1" />
                              <circle cx="15" cy="5" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="19" r="1" />
                            </svg>
                          </div>
                        )}
                        <span className={`flex-shrink-0 transition-colors ${isActive ? "text-blue-600" : "text-slate-400 group-hover:text-slate-600"} ${isDragEnabled && !collapsed ? "" : ""}`}>
                          {link.icon}
                        </span>
                        {!collapsed && (
                          <span className="flex-1 truncate">{link.label}</span>
                        )}
                        {!collapsed && link.badge && (
                          <span className={`
                            text-[10px] font-bold px-2 py-0.5 rounded-full flex-shrink-0 ml-auto
                            ${isActive ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-500"}
                          `}>
                            {link.badge}
                          </span>
                        )}
                        {!collapsed && link.subLinks && (
                          <svg
                            className={`ml-auto w-4 h-4 transition-transform duration-200 text-slate-400 ${expandedMenus[link.href] ? "rotate-180" : ""}`}
                            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        )}
                        {collapsed && link.badge && (
                          <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-blue-500" />
                        )}
                      </Link>

                      {/* Sub-links Rendering */}
                      {!collapsed && link.subLinks && expandedMenus[link.href] && (
                        <div className="mt-1 mb-2 ml-[36px] relative space-y-1 animate-in slide-in-from-top-1 fade-in duration-200 mr-2">
                          {/* Continuous vertical line for the tree */}
                          <div className="absolute left-[9px] top-2 bottom-3.5 w-[2px] bg-slate-100 rounded-full" />

                          {link.subLinks.map((sub: any) => {
                            const isSubActive = activeHref === sub.href;
                            return (
                              <Link
                                key={sub.href}
                                href={sub.href}
                                onClick={() => setActiveHref(sub.href)}
                                className={`
                                  group relative flex items-center pl-7 pr-3 py-1.5 text-[12px] rounded-lg transition-all duration-200
                                  ${isSubActive
                                    ? "text-blue-700 font-bold bg-blue-50/50 ring-1 ring-blue-100/50 shadow-sm"
                                    : "text-slate-500 font-medium hover:text-slate-900 hover:bg-slate-50"}
                                `}
                              >
                                {/* Active / Hover Dot */}
                                <div
                                  className={`absolute left-[6.5px] w-[7px] h-[7px] rounded-full transition-all duration-200 z-10
                                    ${isSubActive
                                      ? "bg-blue-500 ring-4 ring-blue-50"
                                      : "bg-slate-200 ring-2 ring-white group-hover:bg-slate-400 group-hover:scale-125"
                                    }
                                  `}
                                />

                                <span className="truncate tracking-wide">{sub.label}</span>
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
              Reset Menu Order
            </button>
          </div>
        )}
      </nav>

      {/* ── User & Logout ─────────────────────────────────────────────────── */}
      <div className="p-3 border-t border-slate-100 bg-slate-50 flex-shrink-0">
        <div className={`flex items-center hover:bg-white rounded-xl transition-colors p-2 ${collapsed ? "justify-center" : "gap-3"}`}>
          <Link href="/profile" className="flex items-center gap-3 flex-1 min-w-0" title="Profile">
            <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold text-sm shadow-sm flex-shrink-0 ring-2 ring-white">
              {userName.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() || "SR"}
            </div>
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-slate-900 truncate">{userName}</p>
                <p className="text-[10px] text-slate-500 truncate">{userRole || userEmail}</p>
              </div>
            )}
          </Link>
          {!collapsed && (
            <button
              type="button"
              title="Logout"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                localStorage.clear();
                window.location.replace("/login");
              }}
              className="text-slate-400 hover:text-red-500 hover:bg-red-50 p-1.5 rounded-lg transition-colors cursor-pointer flex-shrink-0 relative z-50"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                <polyline points="16 17 21 12 16 7"></polyline>
                <line x1="21" y1="12" x2="9" y2="12"></line>
              </svg>
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
