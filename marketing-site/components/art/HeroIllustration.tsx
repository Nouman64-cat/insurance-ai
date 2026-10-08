import { useId } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";

export type IllustrationKind = "family" | "individual" | "group" | "platform";

// Original illustration for the hero areas: a protective shield (the product's promise)
// with the subject of each page inside it, and the platform's capabilities orbiting it.
//
// Performance: animating anything inside one big SVG repaints the whole SVG every frame, which
// is what made the landing page lag. The art is therefore split into stacked layers, and each
// animation (glow pulse, ring rotation, node float) moves a whole layer with transform/opacity
// only, so the browser animates it on the GPU without repainting.

const VB = { x: 36, y: 20, w: 590, h: 540 };
const VIEW_BOX = `${VB.x} ${VB.y} ${VB.w} ${VB.h}`;
const RING_CENTER = { x: 320, y: 270 };

const SHIELD = "M320 130 L425 168 V262 C425 325 382 365 320 392 C258 365 215 325 215 262 V168 Z";
const SHIELD_INNER = "M320 146 L410 178 V260 C410 314 373 349 320 372 C267 349 230 314 230 260 V178 Z";

const orbit: { x: number; y: number; icon: IconName; label: string; delay: string }[] = [
  { x: 118, y: 104, icon: "file", label: "Policy", delay: "0s" },
  { x: 544, y: 112, icon: "spark", label: "AI underwriting", delay: "-1.6s" },
  { x: 566, y: 330, icon: "coin", label: "Claims", delay: "-3.1s" },
  { x: 76, y: 214, icon: "users", label: "Agents", delay: "-4.4s" },
  { x: 410, y: 486, icon: "graph", label: "Fraud graph", delay: "-5.6s" },
];

const pct = (v: number, origin: number, size: number) => `${((v - origin) / size) * 100}%`;

function Family({ person }: Readonly<{ person: string }>) {
  return (
    <g fill={person}>
      <circle cx="284" cy="235" r="17" />
      <path d="M262 335 V277 a22 22 0 0 1 44 0 V335 Z" />
      <circle cx="356" cy="235" r="17" />
      <path d="M334 335 V277 a22 22 0 0 1 44 0 V335 Z" />
      <circle cx="320" cy="281" r="13" fill="#8cb8ff" />
      <path d="M305 335 V316 a15 15 0 0 1 30 0 V335 Z" fill="#8cb8ff" />
    </g>
  );
}

function Individual({ person }: Readonly<{ person: string }>) {
  return (
    <g fill={person}>
      <circle cx="320" cy="236" r="21" />
      <path d="M290 335 V285 a30 30 0 0 1 60 0 V335 Z" />
    </g>
  );
}

const windows = [0, 1, 2].flatMap((c) => [0, 1, 2, 3].map((r) => ({ c, r })));

function Group({ person }: Readonly<{ person: string }>) {
  return (
    <g>
      <rect x="244" y="272" width="32" height="63" rx="4" fill="#5b9bff" opacity="0.55" />
      <rect x="364" y="258" width="32" height="77" rx="4" fill="#5b9bff" opacity="0.55" />
      <rect x="280" y="206" width="80" height="129" rx="6" fill={person} />
      {windows.map(({ c, r }) => (
        <rect key={`${c}-${r}`} x={290 + c * 24} y={220 + r * 24} width="14" height="14" rx="2" fill="#0a2370" opacity="0.85" />
      ))}
      <rect x="308" y="312" width="24" height="23" rx="3" fill="#0a2370" />
    </g>
  );
}

const satellites = [
  [270, 224],
  [370, 224],
  [276, 312],
  [364, 312],
];

function Platform({ person }: Readonly<{ person: string }>) {
  return (
    <g>
      {satellites.map(([x, y]) => (
        <g key={`${x}-${y}`}>
          <line x1="320" y1="268" x2={x} y2={y} stroke="#5b9bff" strokeWidth="1.5" opacity="0.7" />
          <circle cx={x} cy={y} r="11" fill="#8cb8ff" />
        </g>
      ))}
      <circle cx="320" cy="268" r="24" fill={person} />
      <circle cx="320" cy="268" r="9" fill="#0a2370" />
    </g>
  );
}

const motifs = { family: Family, individual: Individual, group: Group, platform: Platform } as const;

const layer = "absolute inset-0 h-full w-full";

export function HeroIllustration({ kind = "family", className = "" }: Readonly<{ kind?: IllustrationKind; className?: string }>) {
  const Motif = motifs[kind];
  const uid = useId().replace(/:/g, "");
  const person = `url(#art-person-${uid})`;

  return (
    <div
      className={`relative aspect-[590/540] ${className}`}
      style={{ containerType: "inline-size" }}
      aria-hidden="true"
    >
      {/* Layer 1: glow. Pulses by opacity only. */}
      <svg viewBox={VIEW_BOX} className={`${layer} animate-glow`} focusable="false">
        <defs>
          <radialGradient id={`art-glow-${uid}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#2563eb" stopOpacity="0.5" />
            <stop offset="55%" stopColor="#1d4ed8" stopOpacity="0.14" />
            <stop offset="100%" stopColor="#1d4ed8" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx={RING_CENTER.x} cy={RING_CENTER.y} r="270" fill={`url(#art-glow-${uid})`} />
      </svg>

      {/* Layer 2: slowly rotating dotted ring. The whole layer rotates (transform only). */}
      <svg
        viewBox={VIEW_BOX}
        className={`${layer} animate-spin-slow`}
        style={{
          transformOrigin: `${pct(RING_CENTER.x, VB.x, VB.w)} ${pct(RING_CENTER.y, VB.y, VB.h)}`,
        }}
        focusable="false"
      >
        <circle
          cx={RING_CENTER.x}
          cy={RING_CENTER.y}
          r="211"
          fill="none"
          stroke="#8fb2ee"
          strokeWidth="1.25"
          strokeDasharray="2 10"
        />
      </svg>

      {/* Layer 3: static artwork, painted once. */}
      <svg viewBox={VIEW_BOX} className={layer} focusable="false">
        <defs>
          <linearGradient id={`art-stroke-${uid}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#93c5fd" />
            <stop offset="100%" stopColor="#2563eb" />
          </linearGradient>
          <linearGradient id={`art-fill-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2a5fe0" />
            <stop offset="100%" stopColor="#0a2370" />
          </linearGradient>
          <linearGradient id={`art-person-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="#a9ccff" />
          </linearGradient>
        </defs>

        <circle cx={RING_CENTER.x} cy={RING_CENTER.y} r="236" fill="none" stroke="#d3e1f8" strokeWidth="1" />
        <circle cx={RING_CENTER.x} cy={RING_CENTER.y} r="186" fill="none" stroke="#d3e1f8" strokeWidth="1" />

        {orbit.map((n) => (
          <line
            key={n.label}
            x1={RING_CENTER.x}
            y1={RING_CENTER.y}
            x2={n.x}
            y2={n.y}
            stroke="#9dbdf0"
            strokeWidth="1.25"
            strokeDasharray="4 7"
          />
        ))}

        <path d={SHIELD} fill={`url(#art-fill-${uid})`} stroke={`url(#art-stroke-${uid})`} strokeWidth="3" strokeLinejoin="round" />
        <path d={SHIELD_INNER} fill="none" stroke="#93b4f5" strokeWidth="1" strokeLinejoin="round" opacity="0.6" />
        <ellipse cx="320" cy="338" rx="74" ry="6" fill="#2563eb" opacity="0.35" />
        <polyline
          points="236,205 284,205 298,180 314,226 330,192 342,205 404,205"
          fill="none"
          stroke="#ffffff"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.85"
        />
        <Motif person={person} />
      </svg>

      {/* Layer 4: orbiting capabilities as HTML, drifted and pulsed by transform/opacity. Sizes use cqw so they
          scale with the illustration. */}
      {orbit.map((n) => (
        <div
          key={n.label}
          className="absolute -translate-x-1/2 -translate-y-1/2"
          style={{ left: pct(n.x, VB.x, VB.w), top: pct(n.y, VB.y, VB.h) }}
        >
          <div className="animate-drift relative" style={{ animationDelay: n.delay }}>
            {/* Soft ring that pulses outward from the box (transform and opacity only) */}
            <span
              className="node-ping absolute inset-0 bg-brand/40"
              style={{ borderRadius: "2.6cqw", animationDelay: n.delay }}
            />
            <span
              className="relative flex items-center justify-center bg-gradient-to-b from-brand to-brand-dark text-white shadow-glow"
              style={{ width: "9.8cqw", height: "9.8cqw", borderRadius: "2.6cqw" }}
            >
              <span style={{ width: "4.4cqw", height: "4.4cqw" }}>
                <Icon name={n.icon} className="h-full w-full" />
              </span>
            </span>
            <span
              className="absolute left-1/2 top-full -translate-x-1/2 whitespace-nowrap font-medium text-muted"
              style={{ marginTop: "0.8cqw", fontSize: "2.2cqw" }}
            >
              {n.label}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
