"use client";

export interface DashboardTab {
  id: string;
  label: string;
}

interface DashboardTabsProps {
  tabs: DashboardTab[];
  active: string;
  onChange: (id: string) => void;
}

/** Slim category tab bar shared across the portal's dashboard screens. */
export function DashboardTabs({ tabs, active, onChange }: DashboardTabsProps) {
  return (
    <div className="flex items-center gap-1 bg-slate-100/90 p-1 rounded-xl text-[11px] font-bold flex-wrap">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`px-3 py-1.5 rounded-lg transition-all duration-200 whitespace-nowrap ${
            active === tab.id ? "bg-white text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-800"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
