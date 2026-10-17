import type { ReactNode } from "react";

const icons: Record<string, ReactNode> = {
  shield: <path d="M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-3z" />,
  check: <path d="M5 12l4 4 10-10" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18" />,
  chat: <path d="M4 5h16v11H9l-5 4V5z" />,
  phone: <path d="M8 3h8a1 1 0 011 1v16a1 1 0 01-1 1H8a1 1 0 01-1-1V4a1 1 0 011-1zM11 18h2" />,
  file: <path d="M7 3h7l4 4v14H7V3zM14 3v4h4M10 12h5M10 16h5" />,
  users: <path d="M9 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3 2.5-5 6-5s6 2 6 5M16 5.5a3 3 0 010 5.5M18 15c2 .5 3 2.2 3 5" />,
  building: <path d="M5 21V4h9v17M14 9h5v12M8 8h3M8 12h3M8 16h3M3 21h18" />,
  heart: <path d="M12 20s-7-4.5-7-10a4 4 0 017-2.5A4 4 0 0119 10c0 5.5-7 10-7 10z" />,
  graph: (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="8" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M7.7 7l8.6.7M7 8l4 8M17 10l-4 6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </>
  ),
  chart: <path d="M4 20V11M10 20V5M16 20v-7M22 20H2" />,
  coin: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6v2M12 16v2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M16 16l4 4" />
    </>
  ),
  alert: <path d="M12 4l9 16H3L12 4zM12 10v4M12 17v.5" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
};

export type IconName = keyof typeof icons;

export function Icon({ name, className = "h-5 w-5" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {icons[name]}
    </svg>
  );
}

// Icon drawn inside an existing <svg> (used by the hero illustration's orbit nodes).
export function IconGlyph({
  name,
  x,
  y,
  size = 24,
}: Readonly<{ name: IconName; x: number; y: number; size?: number }>) {
  return (
    <svg
      x={x}
      y={y}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {icons[name]}
    </svg>
  );
}
