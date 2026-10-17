import api from "./api";

export type SearchResultType = "case" | "customer" | "policy" | "claim";

export interface SearchResult {
  type: SearchResultType;
  id: string;
  title: string;
  subtitle: string;
  url: string;
}

/**
 * Global search backing the top-bar search box. Hits the gateway's
 * GET /tenants/{tenantId}/search, which scans cases, customers, policies and
 * claims (tenant-scoped) and returns a flat, ranked list of hits.
 *
 * Pass an AbortSignal so the caller can cancel an in-flight request when the
 * query changes.
 */
export async function globalSearch(
  tenantId: string,
  q: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const res = await api.get(`/tenants/${tenantId}/search`, {
    params: { q },
    signal,
  });
  return res.data?.results ?? [];
}
