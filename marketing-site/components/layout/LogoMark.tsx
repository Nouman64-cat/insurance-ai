// Shield-and-check mark. `animated` draws the strokes in (used by the landing splash).
export function LogoMark({ className = "h-8 w-8 rounded-lg", animated = false }: { className?: string; animated?: boolean }) {
  return (
    <span className={`inline-flex items-center justify-center bg-brand text-white ${className}`}>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="h-[58%] w-[58%]"
      >
        <path
          d="M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-3z"
          pathLength={1}
          className={animated ? "logo-draw" : undefined}
        />
        <path d="M8.5 12l2.5 2.5 4.5-5" pathLength={1} className={animated ? "logo-draw-2" : undefined} />
      </svg>
    </span>
  );
}
