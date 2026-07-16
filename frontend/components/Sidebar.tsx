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

    group: "Underwriting",

    links: [

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

        href: "/proposal",

        label: "Proposal",

        icon: (

          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">

            <line x1="12" y1="1" x2="12" y2="23" />

            <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />

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

    group: "Management",

    links: [

      /*

            {

              href: "/reports",

              label: "Reports",

              icon: (

                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">

                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" />

                  <line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><line x1="10" y1="9" x2="8" y2="9" />

                </svg>

              ),

              badge: null,

            },

      */

      {

        href: "/admin/customers",

        label: "Customer Profile",

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

        href: "/admin/organizations",

        label: "Organization Management",

        icon: (

          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">

            <path d="M6 22V4a2 2 0 012-2h8a2 2 0 012 2v18z" />

            <path d="M6 12H4a2 2 0 00-2 2v8h4" />

            <path d="M18 9h2a2 2 0 012 2v11h-4" />

            <line x1="10" y1="6" x2="14" y2="6" /><line x1="10" y1="10" x2="14" y2="10" />

            <line x1="10" y1="14" x2="14" y2="14" /><line x1="10" y1="18" x2="14" y2="18" />

          </svg>

        ),

        badge: null,

        adminOnly: true,

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



  useEffect(() => {

    setActiveHref(pathname);

  }, [pathname]);



  useEffect(() => {

    const storedName = localStorage.getItem("user_name");

    const storedEmail = localStorage.getItem("user_email");

    const storedRole = localStorage.getItem("user_role");

    const savedMode = localStorage.getItem("demo_nav_mode");

    if (storedName) setUserName(storedName);

    if (storedEmail) setUserEmail(storedEmail);

    if (storedRole) setUserRole(storedRole);

    if (savedMode === "working") setNavMode("working");

  }, []);



  const handleNavModeChange = (mode: "all" | "working") => {

    setNavMode(mode);

    localStorage.setItem("demo_nav_mode", mode);

  };



  const handleLogout = () => {

    localStorage.removeItem("jwt_token");

    localStorage.removeItem("tenant_id");

    localStorage.removeItem("user_email");

    localStorage.removeItem("user_name");

    localStorage.removeItem("user_role");

    window.location.href = "/login";

  };



  const initials = userName

    .split(" ")

    .map((n) => n[0])

    .join("")

    .slice(0, 2)

    .toUpperCase() || "SR";



  const workingHrefs = ["/profile", "/cases", "/artifacts", "/live-evaluation", "/case-summarizer", "/assessments", "/underwriting", "/admin/users", "/admin/customers", "/financial"];

  const superAdminHrefs = ["/super-admin/tenants", "/super-admin/admins", "/super-admin/branches", "/super-admin/tokens"];



  const displayGroups = (userRole === "SuperAdmin"

    ? [

      {

        group: "PLATFORM ADMINISTRATION",

        links: NAV_ITEMS.flatMap((g) => g.links as any).filter((link: any) => superAdminHrefs.includes(link.href)),

      },

    ]

    : navMode === "working"

      ? [

        {

          group: "WORKING MODULES",

          links: NAV_ITEMS.flatMap((g) => g.links as any).filter((link: any) => workingHrefs.includes(link.href)),

        },

      ]

      : NAV_ITEMS) as any;



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

        {displayGroups.map((group: any, index: number) => {

          const visibleLinks = group.links.filter((link: any) => {

            if (link.adminOnly && userRole !== "Admin") return false;

            if (link.superAdminOnly && userRole !== "SuperAdmin") return false;

            return true;

          });

          if (visibleLinks.length === 0) return null;



          return (

            <div key={group.group} className={collapsed && index > 0 ? "pt-5 border-t border-slate-200 w-full" : ""}>

              {!collapsed && (

                <p className="px-2 mb-1.5 text-[9px] font-bold uppercase tracking-[0.15em] text-slate-600">

                  {group.group}

                </p>

              )}

              <div className="space-y-0.5">

                {visibleLinks.map((link: any) => {

                  const isActive = activeHref === link.href;

                  return (

                    <Link

                      key={link.href}

                      href={link.href}

                      title={collapsed ? link.label : undefined}

                      onClick={() => setActiveHref(link.href)}

                      className={`

                      sidebar-link group flex items-center transition-all duration-150 text-[13px]

                      ${collapsed ? "w-11 h-11 justify-center rounded-xl mx-auto p-0" : "gap-2.5 px-3 py-2.5 rounded-xl mx-2"}

                      ${isActive

                          ? "bg-blue-50 text-blue-700 font-bold shadow-sm ring-1 ring-blue-100/50"

                          : "text-slate-600 font-medium hover:text-slate-900 hover:bg-slate-50"

                        }

                    `}

                    >

                      <span className={`flex-shrink-0 transition-colors ${isActive ? "text-blue-600" : "text-slate-400 group-hover:text-slate-600"}`}>

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

                  );

                })}

              </div>

            </div>

          );

        })}

      </nav>



      {/* ── User footer ───────────────────────────────────────────────────── */}

      <div className={`border-t border-slate-200 p-4 flex-shrink-0 ${collapsed ? "flex flex-col items-center gap-4" : ""}`}>

        <div className={`flex items-center gap-3 group rounded-xl p-2 hover:bg-slate-50 transition-colors ${collapsed ? "justify-center p-0 hover:bg-transparent" : "w-full"}`}>

          <Link

            href="/profile"

            title="View Profile"

            className={`flex items-center gap-3 min-w-0 ${collapsed ? "justify-center" : "flex-1"}`}

          >

            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center flex-shrink-0 shadow-sm ring-2 ring-white">

              <span className="text-xs font-bold text-white tracking-wider">{initials}</span>

            </div>

            {!collapsed && (

              <div className="overflow-hidden pr-2">

                <p className="text-sm font-bold text-slate-900 truncate leading-tight">{userName}</p>

                <p className="text-xs font-medium text-slate-500 mt-0.5 truncate">{userEmail}</p>

              </div>

            )}

          </Link>

          {!collapsed && (

            <button

              onClick={handleLogout}

              className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors flex-shrink-0"

              title="Log Out"

            >

              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor" className="w-5 h-5">

                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />

              </svg>

            </button>

          )}

        </div>

        {collapsed && (

          <button

            onClick={handleLogout}

            className="p-2 rounded-xl text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors flex-shrink-0"

            title="Log Out"

          >

            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor" className="w-5 h-5">

              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />

            </svg>

          </button>

        )}

      </div>

    </aside>

  );

}