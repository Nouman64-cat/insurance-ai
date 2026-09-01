"use client";

import { FilterDropdown, type FilterOption } from "./FilterDropdown";

const PinIcon = (
  <svg className="w-3.5 h-3.5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

export const ALL_REGIONS = "ALL";

interface RegionFilterProps {
  regions: string[];
  value: string;
  onChange: (region: string) => void;
  className?: string;
}

/** Single-select region dropdown, built on the shared FilterDropdown. */
export function RegionFilter({ regions, value, onChange, className }: RegionFilterProps) {
  const options: FilterOption[] = [
    { value: ALL_REGIONS, label: "All Regions", icon: PinIcon },
    ...regions.map((r) => ({ value: r, label: r })),
  ];
  return (
    <FilterDropdown value={value} options={options} onChange={onChange} className={className} placeholder="Region" />
  );
}
