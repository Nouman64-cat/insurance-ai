import api from "./api";

export interface Branch {
  id: string;
  name: string;
  branch_code: string;
  city: string;
  region?: string | null;
}

export async function listBranches(tenantId: string): Promise<Branch[]> {
  const resp = await api.get<Branch[]>(`/tenants/${tenantId}/branches`);
  return resp.data;
}

/** Distinct, non-empty regions across a tenant's branches, alphabetically sorted. */
export function distinctRegions(branches: Branch[]): string[] {
  return Array.from(new Set(branches.map((b) => b.region).filter((r): r is string => !!r))).sort();
}

/** Resolves a payee's branch text to a region name using branch names, cities, and regions. */
export function resolvePayeeRegion(payeeBranch: string | null | undefined, branches: Branch[]): string | undefined {
  if (!payeeBranch) return undefined;

  const lowerBranch = payeeBranch.toLowerCase().trim();

  // 1. Direct region match
  const directRegion = branches.find((b) => b.region && b.region.toLowerCase() === lowerBranch);
  if (directRegion && directRegion.region) return directRegion.region;

  // 2. Direct name match
  const directName = branches.find((b) => b.name && b.name.toLowerCase() === lowerBranch);
  if (directName && directName.region) return directName.region;

  // 3. Direct city match
  const directCity = branches.find((b) => b.city && b.city.toLowerCase() === lowerBranch);
  if (directCity && directCity.region) return directCity.region;

  // 4. Substring match against city/region/name
  for (const b of branches) {
    if (b.city && lowerBranch.includes(b.city.toLowerCase()) && b.region) return b.region;
    if (b.region && lowerBranch.includes(b.region.toLowerCase()) && b.region) return b.region;
    if (b.name && lowerBranch.includes(b.name.toLowerCase()) && b.region) return b.region;
  }

  // 5. Keyword fallbacks
  if (lowerBranch.includes("karachi") || lowerBranch.includes("south")) return "Sindh";
  if (lowerBranch.includes("lahore") || lowerBranch.includes("punjab")) return "Punjab";
  if (lowerBranch.includes("islamabad")) return "Islamabad Capital Territory";
  if (lowerBranch.includes("peshawar")) return "Khyber Pakhtunkhwa";
  if (lowerBranch.includes("quetta")) return "Balochistan";

  return payeeBranch;
}
