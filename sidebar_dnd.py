import re

with open('frontend/components/Sidebar.tsx', 'r') as f:
    content = f.read()

# We need to replace the Sidebar component definition.
sidebar_start = content.find("export function Sidebar() {")
if sidebar_start == -1:
    print("Could not find Sidebar component")
    exit(1)

new_sidebar = """export function Sidebar() {
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
                          <div className="opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500 mr-1 flex-shrink-0 transition-opacity">
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
        <Link href="/profile" className={`flex items-center hover:bg-white rounded-xl transition-colors p-2 ${collapsed ? "justify-center" : "gap-3"}`}>
          <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold text-sm shadow-sm flex-shrink-0 ring-2 ring-white">
            {userName.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() || "SR"}
          </div>
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-slate-900 truncate">{userName}</p>
              <p className="text-[10px] text-slate-500 truncate">{userRole || userEmail}</p>
            </div>
          )}
          {!collapsed && (
            <div className="text-slate-400 hover:text-slate-600 p-1">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                <polyline points="16 17 21 12 16 7"></polyline>
                <line x1="21" y1="12" x2="9" y2="12"></line>
              </svg>
            </div>
          )}
        </Link>
      </div>
    </aside>
  );
}
"""

content = content[:sidebar_start] + new_sidebar

with open('frontend/components/Sidebar.tsx', 'w') as f:
    f.write(content)

print("Sidebar component replaced successfully.")
