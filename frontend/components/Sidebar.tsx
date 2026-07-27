"use client";



import Link from "next/link";

import { usePathname } from "next/navigation";

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
{

    group: "Main",

    links: [

      {

        href: "/",

        label: "Dashboard",

        icon: (

          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">

            <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />

            <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />

          </svg>

        ),

        badge: null,

      },
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

        href: "/underwriting",

        label: "Underwriting",

        icon: (

          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">

            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />

          </svg>

        ),

        badge: null,

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

      /*

            {

              href: "/submissions",

              label: "Submissions",

              icon: (

                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">

                  <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />

                  <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />

                </svg>

              ),

              badge: "14",

            },

      */

    ],

  },

{
    group: "Customer Management",
    links: [
      
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
    ],
  },

  {
    group: "Insurance Operations",
    links: [
      {
        href: "/policy-issuance",
        label: "Policy Issuance",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <polyline points="9 15 11 17 15 13" />
          </svg>
        ),
        badge: null,
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
    ],
  },
  {
    group: "Intelligence",

    links: [

      /*

            {

              href: "/fraud",

              label: "Fraud Detection",

              icon: (

                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">

                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />

                  <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />

                </svg>

              ),

              badge: "3",

            },

      */

      // {

      //   href: "/score-engine",

      //   label: "Score Engine",

      //   icon: (

      //     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">

      //       <circle cx="12" cy="12" r="10" />

      //       <circle cx="12" cy="12" r="6" />

      //       <circle cx="12" cy="12" r="2" />

      //     </svg>

      //   ),

      //   badge: null,

      // },

      

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

{

    group: "Underwriting",

    links: [

      

      {

        href: "/applications",

        label: "Applications",

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

    ],

  },

{

    group: "Documents",

    links: [

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

        href: "/artifacts",

        label: "Artifacts",

        icon: (

          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">

            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />

            <polyline points="14 2 14 8 20 8" />

            <polyline points="9 15 11 17 15 13" />

          </svg>

        ),

        badge: null,

      },

    ],

  },

{

    // group: "Claims",

    links: [

      /*

            {

              href: "/claims",

              label: "Claims",

              icon: (

                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">

                  <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />

                </svg>

              ),

              badge: null,

            },

      */

      /*

            {

              href: "/reimbursements",

              label: "Reimbursements",

              icon: (

                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">

                  <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z" />

                  <line x1="9" y1="9" x2="15" y2="9" /><line x1="9" y1="13" x2="15" y2="13" />

                </svg>

              ),

              badge: null,

            },

      */

    ],

  },

{

    // group: "Agents & Finance",

    links: [

      /*

            {

              href: "/agents",

              label: "Agents",

              icon: (

                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">

                  <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" />

                  <path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" />

                </svg>

              ),

              badge: null,

            },

      */

      /*

            {

              href: "/financial",

              label: "Financial",

              icon: (

                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">

                  <line x1="12" y1="1" x2="12" y2="23" />

                  <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />

                </svg>

              ),

              badge: null,

            },

      */

    ],

  },

{

    group: "Administration",

    links: [

      

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

    ],

  },

{

    group: "User",

    links: [

      {

        href: "/admin/users",

        label: "User",

        icon: (

          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">

            <circle cx="12" cy="12" r="3" />

            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />

          </svg>

        ),

        badge: null,

        adminOnly: true,

      },

    ],

  },

{

    group: "Profile",

    links: [

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

] as const;



// ── Component ─────────────────────────────────────────────────────────────────



export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const [activeHref, setActiveHref] = useState(pathname);
  const [userName, setUserName] = useState("Saira Reviewer");
  const [userEmail, setUserEmail] = useState("Senior Underwriter");
  const [userRole, setUserRole] = useState("");
  const [navMode, setNavMode] = useState<"all" | "working">("all");

  // Drag and Drop state
  const initialOrder = NAV_ITEMS.map((g: any) => ({ group: g.group, links: g.links.map((l: any) => l.href) }));
  const [navOrder, setNavOrder] = useState(initialOrder);
  const [draggedItem, setDraggedItem] = useState<{groupIndex: number, linkIndex: number} | null>(null);
  const [draggedOverItem, setDraggedOverItem] = useState<{groupIndex: number, linkIndex: number} | null>(null);

  useEffect(() => {
    setActiveHref(pathname);
  }, [pathname]);

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
        // Merge missing links from NAV_ITEMS if any new ones were added
        const allSavedHrefs = new Set(parsed.flatMap((g: any) => g.links));
        const missingLinks = NAV_ITEMS.flatMap((g: any) => g.links).filter((l: any) => !allSavedHrefs.has(l.href));
        if (missingLinks.length > 0 && parsed.length > 0) {
          parsed[0].links.push(...missingLinks.map((l: any) => l.href));
        }
        setNavOrder(parsed);
      } catch (e) {}
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

  const workingHrefs = ["/profile", "/cases", "/artifacts", "/live-evaluation", "/case-summarizer", "/assessments", "/underwriting", "/admin/users", "/admin/leads", "/admin/policyholders", "/financial"];
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
            <span className="text-slate-900 font-bold text-[17px] tracking-tight whitespace-nowrap">
              insurance<span className="text-blue-400">-ai</span>
            </span>
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
                  const isActive = activeHref === link.href;
                  const isDraggingThis = draggedItem?.groupIndex === gIndex && draggedItem?.linkIndex === lIndex;

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
                        href={link.href}
                        title={collapsed ? link.label : undefined}
                        onClick={() => setActiveHref(link.href)}
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
                              <circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/>
                              <circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>
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
                        {collapsed && link.badge && (
                          <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-blue-500" />
                        )}
                      </Link>
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
