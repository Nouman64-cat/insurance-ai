"use client";

import React, { useEffect, useMemo, useState } from "react";
import { DeckGL, ColumnLayer, PolygonLayer, TextLayer, ScatterplotLayer, FlyToInterpolator } from "deck.gl";
import { Map as MapLibreMap } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import { PillarCard } from "./shared";
import { resolveCityCoords, PAKISTAN_CITIES } from "@/lib/pakistanCities";
import { PROVINCE_SHAPES, provincePolygonLngLat, provinceLabelLngLat, provinceColor, normalizeProvince } from "@/lib/pakistanGeo";
import type { PolicyListItem } from "@/app/services/policies";
import type { Claim } from "@/app/services/claims";
import type { CommissionLedgerEntry } from "@/app/services/commissions";
import type { LeadGeoRecord } from "@/app/services/customers";

interface Density3DMapCardProps {
  policies: PolicyListItem[];
  claims: Claim[];
  ledger: CommissionLedgerEntry[];
  leads: LeadGeoRecord[];
  selectedRegion: string;
  onSelectRegion: (region: string) => void;
}

type MetricMode = "leads" | "premiums" | "claims" | "policies" | "commissions";

interface CityStats {
  name: string;
  lat: number;
  lng: number;
  province: string;
  leadsCount: number;
  claimsCount: number;
  claimsPaid: number;
  policiesCount: number;
  premiumTotal: number;
  commissionTotal: number;
}

const METRIC_LABELS: Record<MetricMode, string> = {
  leads: "Leads",
  premiums: "Premiums (GWP)",
  claims: "Claims Paid",
  policies: "Policyholders",
  commissions: "Commissions",
};

// Dark basemap — no built-in labels so our province/city layers render clean.
const MAP_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json";

const INITIAL_VIEW_STATE = {
  longitude: 69.3451,
  latitude: 30.3753,
  zoom: 4.4,
  pitch: 52,
  bearing: -8,
};

// Camera starts pulled back and flat, then flies in to INITIAL_VIEW_STATE on
// mount — the map should feel like it's arriving, not just appearing.
const ENTRY_VIEW_STATE = {
  longitude: 69.3451,
  latitude: 30.3753,
  zoom: 2.4,
  pitch: 0,
  bearing: 0,
};

const RECENT_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── Static geo layers — computed once from the pre-projected province paths ──

const PROVINCE_POLYGONS = PROVINCE_SHAPES.map((shape) => ({
  shape,
  polygon: provincePolygonLngLat(shape),
  labelPos: provinceLabelLngLat(shape),
}));

// ICT/GB/AJK are small and tightly clustered — an on-map code label for each
// would overlap its neighbors, so only the four large provinces get one.
// The others are still identifiable via the color legend and hover/click.
const INLINE_PROVINCE_LABELS = PROVINCE_POLYGONS.filter((p) => p.shape.labelInside);

const CITY_LABEL_KEYS = [
  "karachi", "lahore", "islamabad", "rawalpindi", "faisalabad", "multan",
  "peshawar", "quetta", "hyderabad", "gujranwala", "sialkot", "gilgit",
  "skardu", "muzaffarabad", "gwadar",
];

const CITY_LABELS = CITY_LABEL_KEYS.filter((key) => PAKISTAN_CITIES[key]).map((key) => {
  const c = PAKISTAN_CITIES[key];
  return { key, name: key.replace(/\b\w/g, (ch) => ch.toUpperCase()), lng: c.lng, lat: c.lat };
});

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function getOrCreateCity(map: Map<string, CityStats>, cityName: string | null | undefined): CityStats | null {
  const resolved = resolveCityCoords(cityName);
  if (!resolved) return null;
  const key = resolved.name;
  let entry = map.get(key);
  if (!entry) {
    entry = {
      name: resolved.name,
      lat: resolved.coords.lat,
      lng: resolved.coords.lng,
      province: resolved.coords.province,
      leadsCount: 0,
      claimsCount: 0,
      claimsPaid: 0,
      policiesCount: 0,
      premiumTotal: 0,
      commissionTotal: 0,
    };
    map.set(key, entry);
  }
  return entry;
}

export function Density3DMapCardImpl({
  policies,
  claims,
  ledger,
  leads,
  selectedRegion,
  onSelectRegion,
}: Density3DMapCardProps) {
  const [metricMode, setMetricMode] = useState<MetricMode>("leads");
  const [hoveredCity, setHoveredCity] = useState<CityStats | null>(null);
  const [viewState, setViewState] = useState<
    typeof INITIAL_VIEW_STATE & { transitionDuration?: number; transitionInterpolator?: FlyToInterpolator }
  >(ENTRY_VIEW_STATE);

  // Fly the camera in from the entry state once, on mount.
  useEffect(() => {
    const id = setTimeout(() => {
      setViewState({
        ...INITIAL_VIEW_STATE,
        transitionDuration: 2200,
        transitionInterpolator: new FlyToInterpolator({ speed: 1.15 }),
      });
    }, 200);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cities with a claim filed in the last 24h — driven off the same filtered
  // `claims` prop, so a pulse only shows for what's actually in view.
  const recentCities = useMemo(() => {
    const cutoff = Date.now() - RECENT_ACTIVITY_WINDOW_MS;
    const seen = new Map<string, { name: string; lat: number; lng: number }>();
    claims.forEach((c) => {
      const t = new Date(c.created_at).getTime();
      if (Number.isNaN(t) || t < cutoff) return;
      const resolved = resolveCityCoords(c.city);
      if (!resolved || seen.has(resolved.name)) return;
      seen.set(resolved.name, { name: resolved.name, lat: resolved.coords.lat, lng: resolved.coords.lng });
    });
    return Array.from(seen.values());
  }, [claims]);

  const hasRecentActivity = recentCities.length > 0;
  const [pulseTick, setPulseTick] = useState(0);
  useEffect(() => {
    if (!hasRecentActivity) return;
    const id = setInterval(() => setPulseTick((t) => t + 1), 150);
    return () => clearInterval(id);
  }, [hasRecentActivity]);
  const pulsePhase = pulseTick * 0.35;
  const pulseRadius = 9 + Math.sin(pulsePhase) * 5;
  const pulseAlpha = Math.round(130 + Math.sin(pulsePhase) * 90);

  const cityStats = useMemo(() => {
    const map = new Map<string, CityStats>();

    leads.forEach((lead) => {
      const city = getOrCreateCity(map, lead.city);
      if (city) city.leadsCount += 1;
    });

    claims.forEach((claim) => {
      const city = getOrCreateCity(map, claim.city);
      if (city) {
        city.claimsCount += 1;
        city.claimsPaid += claim.approved_amount || claim.submitted_amount || 0;
      }
    });

    policies.forEach((policy) => {
      const city = getOrCreateCity(map, policy.city);
      if (city) city.policiesCount += 1;
    });

    ledger.forEach((entry) => {
      const city = getOrCreateCity(map, entry.payeeName);
      if (city) {
        city.premiumTotal += entry.collectedPremium || 0;
        city.commissionTotal += entry.netCommission || 0;
      }
    });

    return Array.from(map.values());
  }, [leads, claims, policies, ledger]);

  const maxValues = useMemo(
    () => ({
      leads: Math.max(...cityStats.map((c) => c.leadsCount), 1),
      premiums: Math.max(...cityStats.map((c) => c.premiumTotal), 1),
      claims: Math.max(...cityStats.map((c) => c.claimsPaid), 1),
      policies: Math.max(...cityStats.map((c) => c.policiesCount), 1),
      commissions: Math.max(...cityStats.map((c) => c.commissionTotal), 1),
    }),
    [cityStats]
  );

  const metricValue = (c: CityStats) => {
    switch (metricMode) {
      case "leads":
        return c.leadsCount;
      case "premiums":
        return c.premiumTotal;
      case "claims":
        return c.claimsPaid;
      case "policies":
        return c.policiesCount;
      case "commissions":
        return c.commissionTotal;
    }
  };

  const fmtCompact = (v: number) =>
    v >= 1_000_000 ? `PKR ${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `PKR ${(v / 1_000).toFixed(0)}K` : `${v.toFixed(0)}`;

  const fmtMetric = (c: CityStats) => {
    const v = metricValue(c);
    return metricMode === "premiums" || metricMode === "claims" || metricMode === "commissions" ? fmtCompact(v) : `${v}`;
  };

  const provinceStats = useMemo(() => {
    const byProvince = new Map<string, number>();
    cityStats.forEach((c) => {
      const canonical = normalizeProvince(c.province) ?? c.province;
      byProvince.set(canonical, (byProvince.get(canonical) || 0) + metricValue(c));
    });
    return PROVINCE_SHAPES.map((shape) => ({ shape, value: byProvince.get(shape.name) || 0 })).sort(
      (a, b) => b.value - a.value
    );
  }, [cityStats, metricMode]);

  const maxProvinceValue = Math.max(...provinceStats.map((p) => p.value), 1);

  const layers = [
    new PolygonLayer({
      id: "province-boundaries",
      data: PROVINCE_POLYGONS,
      getPolygon: (d: (typeof PROVINCE_POLYGONS)[number]) => d.polygon,
      stroked: true,
      filled: true,
      pickable: true,
      getFillColor: (d: (typeof PROVINCE_POLYGONS)[number]) => {
        const [r, g, b] = hexToRgb(d.shape.color);
        const isSelected = selectedRegion !== "ALL" && d.shape.name === selectedRegion;
        return [r, g, b, isSelected ? 90 : 45];
      },
      getLineColor: (d: (typeof PROVINCE_POLYGONS)[number]) => {
        const [r, g, b] = hexToRgb(d.shape.color);
        return [r, g, b, 255];
      },
      getLineWidth: 1200,
      lineWidthMinPixels: 1.8,
      onClick: (info: { object?: (typeof PROVINCE_POLYGONS)[number] }) => {
        const p = info.object as (typeof PROVINCE_POLYGONS)[number] | undefined;
        if (!p) return;
        onSelectRegion(selectedRegion === p.shape.name ? "ALL" : p.shape.name);
      },
      updateTriggers: { getFillColor: [selectedRegion] },
    }),
    new TextLayer({
      id: "province-labels",
      data: INLINE_PROVINCE_LABELS,
      getPosition: (d: (typeof PROVINCE_POLYGONS)[number]) => d.labelPos,
      getText: (d: (typeof PROVINCE_POLYGONS)[number]) => d.shape.code,
      getSize: 14,
      getColor: [255, 255, 255, 240],
      getTextAnchor: "middle" as const,
      getAlignmentBaseline: "center" as const,
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontWeight: 800,
      background: true,
      getBackgroundColor: [10, 15, 30, 180],
      backgroundPadding: [5, 3],
      pickable: false,
    }),
    // City markers only — names show on hover (via the tooltip below) rather
    // than as permanent labels, so the cluster of cities in the north doesn't
    // collide with the province codes right next to them.
    new ScatterplotLayer({
      id: "city-dots",
      data: CITY_LABELS,
      getPosition: (d: (typeof CITY_LABELS)[number]) => [d.lng, d.lat],
      getRadius: 4,
      radiusUnits: "pixels" as const,
      getFillColor: [255, 255, 255, 255],
      getLineColor: [30, 41, 59, 220],
      lineWidthMinPixels: 1.5,
      stroked: true,
      filled: true,
      pickable: false,
    }),
    new ColumnLayer<CityStats>({
      id: "density-columns",
      data: cityStats,
      diskResolution: 12,
      radius: 15000,
      extruded: true,
      pickable: true,
      elevationScale: 1,
      getPosition: (d: CityStats) => [d.lng, d.lat],
      getElevation: (d: CityStats) => (metricValue(d) / maxValues[metricMode]) * 260000 + 4000,
      getFillColor: (d: CityStats) => {
        const ratio = maxValues[metricMode] > 0 ? metricValue(d) / maxValues[metricMode] : 0;
        const isSelected = selectedRegion !== "ALL" && normalizeProvince(d.province) === selectedRegion;
        const [r, g, b] = hexToRgb(provinceColor(d.province));
        const lighten = isSelected ? 0 : (1 - ratio) * 0.55;
        const mix = (c: number) => Math.round(c + (255 - c) * lighten);
        return [mix(r), mix(g), mix(b), isSelected ? 235 : Math.round(150 + ratio * 80)];
      },
      getLineColor: [255, 255, 255, 140],
      lineWidthMinPixels: 1,
      onClick: (info: { object?: CityStats }) => {
        const city = info.object as CityStats | undefined;
        if (!city) return;
        const canonical = normalizeProvince(city.province) ?? city.province;
        onSelectRegion(selectedRegion === canonical ? "ALL" : canonical);
      },
      onHover: (info: { object?: CityStats }) => setHoveredCity(info.object ?? null),
      updateTriggers: {
        getElevation: [metricMode, maxValues],
        getFillColor: [metricMode, maxValues, selectedRegion],
      },
    }),
    ...(hasRecentActivity
      ? [
          new ScatterplotLayer({
            id: "recent-activity-pulse",
            data: recentCities,
            getPosition: (d: (typeof recentCities)[number]) => [d.lng, d.lat],
            radiusUnits: "pixels" as const,
            getRadius: pulseRadius,
            filled: false,
            stroked: true,
            getLineColor: [244, 63, 94, pulseAlpha],
            lineWidthMinPixels: 2,
            pickable: false,
            updateTriggers: { getRadius: [pulseTick], getLineColor: [pulseTick] },
          }),
        ]
      : []),
  ];

  const topCities = cityStats
    .filter((c) => metricValue(c) > 0)
    .sort((a, b) => metricValue(b) - metricValue(a))
    .slice(0, 8);
  const unmatchedLeads = leads.length - cityStats.reduce((s, c) => s + c.leadsCount, 0);

  return (
    <PillarCard
      icon={
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.782V8.018a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
        </svg>
      }
      title="Regional Intelligence — Pakistan"
      barClass="bg-blue-600"
      iconBg="bg-blue-50"
      iconColor="text-blue-600"
    >
      <div className="space-y-3">
        {/* Metric Selector Bar */}
        <div className="flex items-center justify-between gap-2 flex-wrap pb-2 border-b border-slate-100">
          <div className="flex items-center gap-1 bg-slate-100/90 p-1 rounded-xl text-[10px] font-bold flex-wrap">
            {(Object.keys(METRIC_LABELS) as MetricMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setMetricMode(mode)}
                className={`px-2.5 py-1 rounded-lg transition-all ${
                  metricMode === mode
                    ? "bg-white text-blue-700 shadow-sm font-bold ring-1 ring-blue-100"
                    : "text-slate-500 hover:text-slate-800 hover:bg-white/50"
                }`}
              >
                {METRIC_LABELS[mode]}
              </button>
            ))}
          </div>

          {selectedRegion !== "ALL" && (
            <button
              onClick={() => onSelectRegion("ALL")}
              className="text-[10px] font-bold text-white bg-blue-600 hover:bg-blue-700 px-2.5 py-1 rounded-lg transition-colors shadow-sm"
            >
              ✕ Reset
            </button>
          )}
        </div>

        {/* Province Filter Chips — individually selectable */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {PROVINCE_SHAPES.map((p) => {
            const isActive = selectedRegion === p.name;
            const isDimmed = selectedRegion !== "ALL" && !isActive;
            return (
              <button
                key={p.name}
                onClick={() => onSelectRegion(isActive ? "ALL" : p.name)}
                title={p.name}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-bold border transition-all ${
                  isActive
                    ? "text-white border-transparent shadow-md scale-105"
                    : isDimmed
                    ? "bg-slate-50 border-slate-200 text-slate-400 opacity-50 hover:opacity-80"
                    : "bg-slate-50 border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-900"
                }`}
                style={isActive ? { backgroundColor: p.color, borderColor: p.color } : undefined}
              >
                <span
                  className="w-2 h-2 rounded-full inline-block flex-shrink-0"
                  style={{ backgroundColor: isActive ? "rgba(255,255,255,0.7)" : p.color }}
                />
                {p.code}
              </button>
            );
          })}
        </div>

        {/* 3D Map Viewport */}
        <div className="relative rounded-2xl overflow-hidden border border-slate-700/40 shadow-xl min-h-[300px] h-[300px]">
          <DeckGL
            viewState={viewState}
            onViewStateChange={(e: any) => setViewState(e.viewState)}
            controller={true}
            layers={layers}
          >
            <MapLibreMap {...viewState} mapStyle={MAP_STYLE} reuseMaps />
          </DeckGL>

          {/* Subtle vignette overlay for depth */}
          <div
            className="absolute inset-0 pointer-events-none rounded-2xl"
            style={{ background: "radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.35) 100%)" }}
          />

          {/* Hover tooltip */}
          {hoveredCity && (
            <div className="absolute top-3 left-3 pointer-events-none z-20">
              <div className="bg-slate-950/95 text-white px-3 py-2.5 rounded-xl shadow-2xl text-xs backdrop-blur-md border border-white/10 space-y-1.5 min-w-[160px]">
                <p className="font-bold text-blue-300 text-[11px] flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-blue-400 inline-block" />
                  {hoveredCity.name}
                  <span className="text-slate-500 font-normal text-[9px] uppercase tracking-wider">{hoveredCity.province}</span>
                </p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] pt-1 border-t border-white/10">
                  <span className="text-slate-400">Leads</span>
                  <span className="font-mono font-bold text-right text-emerald-400">{hoveredCity.leadsCount}</span>
                  <span className="text-slate-400">Policyholders</span>
                  <span className="font-mono font-bold text-right text-sky-400">{hoveredCity.policiesCount}</span>
                  <span className="text-slate-400">Premiums</span>
                  <span className="font-mono font-bold text-right text-violet-400">{fmtCompact(hoveredCity.premiumTotal)}</span>
                  <span className="text-slate-400">Claims</span>
                  <span className="font-mono font-bold text-right text-amber-400">{fmtCompact(hoveredCity.claimsPaid)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Map branding badge */}
          <div className="absolute bottom-2 right-2 bg-slate-950/60 text-slate-400 text-[8px] px-1.5 py-0.5 rounded backdrop-blur-sm pointer-events-none">
            Pakistan · Regional Intelligence
          </div>

          {/* Live activity badge — only shown when there's something to point at */}
          {hasRecentActivity && (
            <div className="absolute bottom-2 left-2 flex items-center gap-1.5 bg-slate-950/70 text-rose-300 text-[9px] font-bold px-2 py-1 rounded-full backdrop-blur-sm pointer-events-none">
              <span className="relative flex w-1.5 h-1.5">
                <span className="absolute inline-flex w-full h-full rounded-full bg-rose-400 opacity-75 animate-ping" />
                <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-rose-400" />
              </span>
              {recentCities.length} {recentCities.length === 1 ? "city" : "cities"} with claims in the last 24h
            </div>
          )}
        </div>

        {/* By Province — selectable region leaderboard */}
        <div className="space-y-1.5 pt-1">
          <h4 className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider">By Province — {METRIC_LABELS[metricMode]}</h4>
          <div className="space-y-1">
            {provinceStats.map((p) => {
              const share = maxProvinceValue > 0 ? (p.value / maxProvinceValue) * 100 : 0;
              const isSelected = selectedRegion === p.shape.name;
              return (
                <div
                  key={p.shape.name}
                  onClick={() => onSelectRegion(isSelected ? "ALL" : p.shape.name)}
                  className={`flex items-center gap-2 cursor-pointer rounded-lg px-2 py-1.5 transition-all ${
                    isSelected
                      ? "bg-slate-800/5 ring-1 ring-inset"
                      : "hover:bg-slate-50"
                  }`}
                  style={isSelected ? ({ "--tw-ring-color": p.shape.color } as React.CSSProperties) : undefined}
                >
                  {/* Colored indicator */}
                  <span
                    className={`w-1.5 h-5 rounded-full shrink-0 transition-all ${
                      isSelected ? "opacity-100" : "opacity-30"
                    }`}
                    style={{ backgroundColor: p.shape.color }}
                  />
                  <span
                    className={`w-28 shrink-0 text-[10px] font-bold truncate transition-colors ${
                      isSelected ? "text-slate-900" : "text-slate-500 hover:text-slate-800"
                    }`}
                    title={p.shape.name}
                  >
                    {p.shape.name}
                  </span>
                  <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.max(share, p.value > 0 ? 3 : 0)}%`,
                        backgroundColor: p.shape.color,
                        opacity: isSelected ? 1 : 0.55,
                      }}
                    />
                  </div>
                  <span className={`w-14 shrink-0 text-right text-[10px] font-mono font-bold ${
                    isSelected ? "text-slate-900" : "text-slate-400"
                  }`}>
                    {metricMode === "premiums" || metricMode === "claims" || metricMode === "commissions" ? fmtCompact(p.value) : p.value}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Top Cities Leaderboard */}
        <div className="space-y-1.5 pt-1">
          <div className="flex justify-between items-center">
            <h4 className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider">Top Cities — {METRIC_LABELS[metricMode]}</h4>
            <span className="text-[10px] text-slate-400 font-semibold">{topCities.length} cities</span>
          </div>

          {topCities.length > 0 ? (
            <div className="bg-slate-50/80 p-2.5 rounded-xl border border-slate-200/60">
              <div className="flex items-end justify-around gap-1.5 h-[115px] pt-3 pb-0.5">
                {topCities.slice(0, 5).map((c) => {
                  const cityProvince = normalizeProvince(c.province) ?? c.province;
                  const isSelected = selectedRegion === cityProvince;
                  const share = maxValues[metricMode] > 0 ? (metricValue(c) / maxValues[metricMode]) * 100 : 0;
                  const barHeightPct = Math.min(Math.max(share, 12), 100);
                  const color = provinceColor(c.province);

                  return (
                    <div
                      key={c.name}
                      onClick={() => onSelectRegion(isSelected ? "ALL" : cityProvince)}
                      className="flex flex-col items-center flex-1 h-full justify-end group cursor-pointer"
                    >
                      <span className="text-[9px] font-extrabold font-mono text-slate-700 mb-1 truncate max-w-full group-hover:scale-105 transition-transform" title={fmtMetric(c)}>
                        {fmtMetric(c)}
                      </span>
                      <div className="w-full bg-slate-200/80 rounded-t-sm h-full flex flex-col justify-end overflow-hidden p-0.5">
                        <div
                          className={`w-full rounded-t-xs transition-all duration-500 hover:brightness-110 ${isSelected ? "ring-2 ring-offset-1 ring-slate-400" : ""}`}
                          style={{ height: `${barHeightPct}%`, backgroundColor: color }}
                        />
                      </div>
                      <span className="text-[9px] font-bold text-slate-700 mt-1 truncate max-w-full text-center" title={`${c.name} (${c.province})`}>
                        {c.name}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="text-[11px] text-slate-400 italic px-1">No geographic data available for this metric yet.</p>
          )}

          {unmatchedLeads > 0 && (
            <p className="text-[9px] text-slate-400 italic px-1">
              {unmatchedLeads} lead{unmatchedLeads === 1 ? "" : "s"} with unrecognized city names.
            </p>
          )}
        </div>
      </div>
    </PillarCard>
  );
}
