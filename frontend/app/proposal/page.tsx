"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import api from "../services/api";
import { getQuote, listQuotes, QuoteDetail, QuoteListItem } from "../services/quotes";
import { MetricCard } from "@/components/MetricCard";
import { SegmentDropdown, SegmentFilter } from "@/components/SegmentDropdown";
import { fmtCoverage } from "@/lib/mock-data";

// ── Constants ─────────────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8010";

const INSURANCE_TYPE_LABELS: Record<string, string> = {
  TERM_LIFE: "Term Life",
  WHOLE_LIFE: "Whole Life",
  ENDOWMENT: "Endowment / Savings Plan",
  CHILD_EDUCATION_MARRIAGE: "Child Education & Marriage Plan",
  GROUP_LIFE: "Group Life",
  SAVINGS: "Savings / Investment Plan",
  SINGLE_PREMIUM: "Single Premium Investment",
  HEALTH_CASH: "Hospital Cash / Health Plan",
};

const SOURCE_TYPE_LABELS: Record<string, string> = {
  AGENT: "Agent",
  BROKER: "Broker",
  BANCASSURANCE: "Bancassurance",
  CORPORATE_AGENT: "Corporate Agent",
  DIRECT: "Direct",
  DIGITAL: "Digital",
};

function formatPKR(n: number): string {
  return `Rs. ${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function formatDate(s: string): string {
  return new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

// A quote only ever carries one of organization_id / family_group_id, never
// both — same mutually-exclusive segmentation the grouping logic below relies on.
function quoteSegment(q: QuoteListItem): "individual" | "family" | "organization" {
  if (q.organization_id && q.master_policy_id) return "organization";
  if (q.family_group_id && q.family_policy_id) return "family";
  return "individual";
}

// ── Grouping types ───────────────────────────────────────────────────────────
// Corporate/group-life quotes (Policy.master_policy_id set) nest three levels
// deep — Organization -> Master Policy -> Customer — so an underwriter can
// browse a census the same way they'd browse folders on disk. Retail quotes
// (no organization) have no policy/org to nest under, so they keep the
// original flat one-folder-per-customer view.

interface CustomerFolderData {
  customer_id: string;
  customer_name: string;
  customer_cnic: string;
  quotes: QuoteListItem[];
}

interface PolicyFolderData {
  master_policy_id: string;
  master_policy_label: string;
  customers: CustomerFolderData[];
}

interface OrganizationFolderData {
  organization_id: string;
  organization_name: string;
  policies: PolicyFolderData[];
}

// Family quotes (Policy.family_policy_id set) nest the same three levels —
// FamilyGroup -> FamilyPolicy (Floater or Life Bundle) -> Customer — reusing
// the identical CustomerFolder leaf. Kept as separate types (not reusing
// OrganizationFolderData/PolicyFolderData) since a FamilyPolicy carries
// plan_type-specific fields an employer MasterPolicy doesn't.

interface FamilyPolicyFolderData {
  family_policy_id: string;
  family_policy_label: string;
  customers: CustomerFolderData[];
}

interface FamilyGroupFolderData {
  family_group_id: string;
  family_group_name: string;
  policies: FamilyPolicyFolderData[];
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function QuotePage() {
  const router = useRouter();
  const [quotes, setQuotes] = useState<QuoteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [segment, setSegment] = useState<SegmentFilter>("all");

  const [selectedQuoteId, setSelectedProposalId] = useState<string | null>(null);
  const [detail, setDetail] = useState<QuoteDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [selectedQuoteIds, setSelectedProposalIds] = useState<Set<string>>(new Set());
  const [isBulkProceeding, setIsBulkProceeding] = useState(false);
  const [bulkProceedError, setBulkProceedError] = useState<string | null>(null);
  const [bulkProceedSuccess, setBulkProceedSuccess] = useState<string | null>(null);

  // Expand state — one Set/id-per-level. IDs are globally unique UUIDs so a
  // flat Set per level is enough; no need to scope by parent. The Family tree
  // reuses expandedCustomerId at its leaf (same reasoning: customer IDs are
  // globally unique whether the customer sits under an org or a family).
  const [expandedOrgId, setExpandedOrgId] = useState<string | null>(null);
  const [expandedPolicyId, setExpandedPolicyId] = useState<string | null>(null);
  const [expandedCustomerId, setExpandedCustomerId] = useState<string | null>(null);
  const [expandedFamilyGroupId, setExpandedFamilyGroupId] = useState<string | null>(null);
  const [expandedFamilyPolicyId, setExpandedFamilyPolicyId] = useState<string | null>(null);

  const toggleOrgFolder = (orgId: string) => {
    setExpandedOrgId((prev) => (prev === orgId ? null : orgId));
    setExpandedPolicyId(null);
    setExpandedCustomerId(null);
  };

  const togglePolicyFolder = (policyId: string) => {
    setExpandedPolicyId((prev) => (prev === policyId ? null : policyId));
    setExpandedCustomerId(null);
  };

  const toggleFamilyGroupFolder = (familyGroupId: string) => {
    setExpandedFamilyGroupId((prev) => (prev === familyGroupId ? null : familyGroupId));
    setExpandedFamilyPolicyId(null);
    setExpandedCustomerId(null);
  };

  const toggleFamilyPolicyFolder = (familyPolicyId: string) => {
    setExpandedFamilyPolicyId((prev) => (prev === familyPolicyId ? null : familyPolicyId));
    setExpandedCustomerId(null);
  };

  const toggleFolder = (customerId: string) => {
    setExpandedCustomerId((prev) => (prev === customerId ? null : customerId));
  };

  const toggleSelection = (quoteId: string) => {
    setSelectedProposalIds((prev) => {
      const next = new Set(prev);
      if (next.has(quoteId)) next.delete(quoteId);
      else next.add(quoteId);
      return next;
    });
  };

  const toggleAllInFolder = (quoteIds: string[]) => {
    setSelectedProposalIds((prev) => {
      const next = new Set(prev);
      const allSelected = quoteIds.every((id) => next.has(id));
      if (allSelected) {
        for (const id of quoteIds) next.delete(id);
      } else {
        for (const id of quoteIds) next.add(id);
      }
      return next;
    });
  };

  const handleBulkProceed = async (customerQuotes: QuoteListItem[]) => {
    const selectedQuotes = customerQuotes.filter((q) => selectedQuoteIds.has(q.quote_id));
    if (selectedQuotes.length === 0) return;

    setIsBulkProceeding(true);
    setBulkProceedError(null);
    setBulkProceedSuccess(null);
    try {
      const tenantId = localStorage.getItem("tenant_id");
      if (!tenantId) throw new Error("Tenant ID not found");

      if (selectedQuotes.length === 1) {
        const q = selectedQuotes[0];
        const caseRes = await api.post(`/tenants/${tenantId}/cases`, {
          customer_id: q.customer_id,
          policy_id: q.policy_id,
          caseType: "Underwriting",
          sourceChannel: "Online",
        });
        router.push(`/case/${caseRes.data.caseld}?autoRun=true`);
        setSelectedProposalIds(new Set());
        setIsBulkProceeding(false);
        return;
      }

      // Multiple items selected — open the same AI underwriting page the single
      // flow uses, but as a switchable group (one case per selected plan).
      // 1. Create a case for each selected plan, keeping the plan label so the
      //    underwriting page can render a plan switcher dropdown.
      const group = await Promise.all(
        selectedQuotes.map(async (q) => {
          const caseRes = await api.post(`/tenants/${tenantId}/cases`, {
            customer_id: q.customer_id,
            policy_id: q.policy_id,
            caseType: "Underwriting",
            sourceChannel: "Online",
          });
          return {
            caseId: caseRes.data.caseld as string,
            planLabel: q.plan_label,
            insuranceType: q.insurance_type,
          };
        })
      );

      // 2. Persist the group so /case/[id] can offer a dropdown to switch plans.
      sessionStorage.setItem("underwriting_group", JSON.stringify(group));

      // 3. Navigate to the first plan's case and auto-run underwriting there.
      router.push(`/case/${group[0].caseId}?autoRun=true`);

      setSelectedProposalIds(new Set());
    } catch (err: any) {
      setBulkProceedError(err.message ?? "Failed to initialize bulk processing.");
    } finally {
      setIsBulkProceeding(false);
    }
  };

  const openQuote = useCallback(async (quoteId: string) => {
    setSelectedProposalId(quoteId);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const data = await getQuote(quoteId);
      setDetail(data);
    } catch (err: any) {
      setDetailError(err.message ?? "Failed to load quotation details.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeQuote = useCallback(() => {
    setSelectedProposalId(null);
    setDetail(null);
    setDetailError(null);
  }, []);

  const fetchQuotes = useCallback(async () => {
    setError(null);
    try {
      const data = await listQuotes();
      setQuotes(data);
    } catch (err: any) {
      setError(err.message ?? "Failed to load quotations.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQuotes();
  }, [fetchQuotes]);

  // The dropdown-selected segment scopes which quotes count toward the stats
  // and folder list; the search box then narrows within that scope.
  const segmentQuotes = useMemo(() => {
    if (segment === "all") return quotes;
    return quotes.filter((q) => quoteSegment(q) === segment);
  }, [quotes, segment]);

  const segmentCounts = useMemo(() => {
    const counts: Partial<Record<SegmentFilter, number>> = { all: quotes.length };
    for (const s of ["individual", "family", "organization"] as const) {
      counts[s] = quotes.filter((q) => quoteSegment(q) === s).length;
    }
    return counts;
  }, [quotes]);

  const kpis = useMemo(() => {
    const customerCount = new Set(segmentQuotes.map((q) => q.customer_id)).size;
    const totalCoverage = segmentQuotes.reduce((sum, q) => sum + q.coverage_amount, 0);
    const totalPremium = segmentQuotes.reduce((sum, q) => sum + q.total_premium, 0);
    return [
      { title: "Customers", value: customerCount, subtitle: "in this view", accent: "blue" as const },
      { title: "Proposals", value: segmentQuotes.length, subtitle: "plans generated", accent: "slate" as const },
      { title: "Total Coverage", value: segmentQuotes.length ? fmtCoverage(totalCoverage) : "—", subtitle: "sum assured", accent: "amber" as const },
      { title: "Total Premium", value: segmentQuotes.length ? fmtCoverage(totalPremium) : "—", subtitle: "annualized", accent: "emerald" as const },
    ];
  }, [segmentQuotes]);

  const { organizationGroups, familyGroups, individualGroups } = useMemo(() => {
    const q = search.trim().toLowerCase();
    let filteredList = segmentQuotes;
    if (q) {
      filteredList = segmentQuotes.filter(
        (row) =>
          row.customer_name.toLowerCase().includes(q) ||
          row.customer_cnic.toLowerCase().includes(q) ||
          row.plan_label.toLowerCase().includes(q) ||
          (row.organization_name?.toLowerCase().includes(q) ?? false) ||
          (row.family_group_name?.toLowerCase().includes(q) ?? false),
      );
    }

    const orgMap = new Map<string, OrganizationFolderData>();
    const familyMap = new Map<string, FamilyGroupFolderData>();
    const individualMap = new Map<string, CustomerFolderData>();

    for (const quote of filteredList) {
      if (quote.organization_id && quote.master_policy_id) {
        let org = orgMap.get(quote.organization_id);
        if (!org) {
          org = {
            organization_id: quote.organization_id,
            organization_name: quote.organization_name ?? "Unknown Organization",
            policies: [],
          };
          orgMap.set(quote.organization_id, org);
        }

        let policy = org.policies.find((p) => p.master_policy_id === quote.master_policy_id);
        if (!policy) {
          policy = {
            master_policy_id: quote.master_policy_id,
            master_policy_label: quote.master_policy_label ?? "Master Policy",
            customers: [],
          };
          org.policies.push(policy);
        }

        let customer = policy.customers.find((c) => c.customer_id === quote.customer_id);
        if (!customer) {
          customer = {
            customer_id: quote.customer_id,
            customer_name: quote.customer_name,
            customer_cnic: quote.customer_cnic,
            quotes: [],
          };
          policy.customers.push(customer);
        }
        customer.quotes.push(quote);
      } else if (quote.family_group_id && quote.family_policy_id) {
        let family = familyMap.get(quote.family_group_id);
        if (!family) {
          family = {
            family_group_id: quote.family_group_id,
            family_group_name: quote.family_group_name ?? "Unknown Family",
            policies: [],
          };
          familyMap.set(quote.family_group_id, family);
        }

        let policy = family.policies.find((p) => p.family_policy_id === quote.family_policy_id);
        if (!policy) {
          policy = {
            family_policy_id: quote.family_policy_id,
            family_policy_label: quote.family_policy_label ?? "Family Policy",
            customers: [],
          };
          family.policies.push(policy);
        }

        let customer = policy.customers.find((c) => c.customer_id === quote.customer_id);
        if (!customer) {
          customer = {
            customer_id: quote.customer_id,
            customer_name: quote.customer_name,
            customer_cnic: quote.customer_cnic,
            quotes: [],
          };
          policy.customers.push(customer);
        }
        customer.quotes.push(quote);
      } else {
        let customer = individualMap.get(quote.customer_id);
        if (!customer) {
          customer = {
            customer_id: quote.customer_id,
            customer_name: quote.customer_name,
            customer_cnic: quote.customer_cnic,
            quotes: [],
          };
          individualMap.set(quote.customer_id, customer);
        }
        customer.quotes.push(quote);
      }
    }

    return {
      organizationGroups: Array.from(orgMap.values()),
      familyGroups: Array.from(familyMap.values()),
      individualGroups: Array.from(individualMap.values()),
    };
  }, [segmentQuotes, search]);

  const totalResults = organizationGroups.length + familyGroups.length + individualGroups.length;

  return (
    <div className="px-6 py-5 max-w-screen-2xl mx-auto w-full space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Proposals</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Generated automatically in the background the moment an customer is registered — no form to fill in.
            Corporate proposals are nested by organization and master policy; family proposals by family and floater/life-bundle policy.
          </p>
        </div>
        <span className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold tracking-wide">
          GET /quotes
        </span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map((k) => <MetricCard key={k.title} {...k} />)}
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap flex-1 min-w-0">
          <input
            type="text"
            placeholder="Search by customer, CNIC, organization, or plan…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full max-w-xs px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
          />
          <SegmentDropdown value={segment} onChange={setSegment} counts={segmentCounts} />
        </div>
        <button
          onClick={fetchQuotes}
          disabled={loading}
          className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}>
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-xs font-bold text-red-700 uppercase tracking-widest mb-1">Error</p>
          <p className="text-xs text-red-600">{error}</p>
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center gap-2">
            <div className="animate-spin h-7 w-7 text-blue-500 rounded-full border-2 border-slate-100 border-t-blue-500" />
            <span className="text-xs text-slate-400">Loading proposals…</span>
          </div>
        ) : totalResults === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center text-center px-6">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-3">
              <span className="text-2xl">📁</span>
            </div>
            <p className="text-sm font-semibold text-slate-600">
              {quotes.length === 0
                ? "No proposals yet"
                : segmentQuotes.length === 0
                ? `No ${segment === "all" ? "" : segment} proposals`
                : "No proposals match your search"}
            </p>
            <p className="text-xs text-slate-400 mt-1.5 max-w-xs leading-relaxed">
              {quotes.length === 0
                ? "Register a customer and a proposal will be generated automatically in the background."
                : segmentQuotes.length === 0
                ? "Try switching the segment filter to All Customers."
                : "Try a different customer name, CNIC, organization, or plan."}
            </p>
          </div>
        ) : (
          <div className="p-4 space-y-5">
            {organizationGroups.length > 0 && (
              <div className="space-y-3">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 px-1">
                  Corporate / Group Life
                </p>
                {organizationGroups.map((org) => (
                  <OrganizationFolder
                    key={org.organization_id}
                    org={org}
                    isExpanded={expandedOrgId === org.organization_id}
                    onToggle={() => toggleOrgFolder(org.organization_id)}
                    expandedPolicyId={expandedPolicyId}
                    onTogglePolicy={togglePolicyFolder}
                    expandedCustomerId={expandedCustomerId}
                    onToggleCustomer={toggleFolder}
                    selectedQuoteIds={selectedQuoteIds}
                    toggleSelection={toggleSelection}
                    toggleAllInFolder={toggleAllInFolder}
                    handleBulkProceed={handleBulkProceed}
                    isBulkProceeding={isBulkProceeding}
                    bulkProceedError={bulkProceedError}
                    bulkProceedSuccess={bulkProceedSuccess}
                    openQuote={openQuote}
                  />
                ))}
              </div>
            )}

            {familyGroups.length > 0 && (
              <div className="space-y-3">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 px-1">
                  Family Insurance
                </p>
                {familyGroups.map((family) => (
                  <FamilyGroupFolder
                    key={family.family_group_id}
                    family={family}
                    isExpanded={expandedFamilyGroupId === family.family_group_id}
                    onToggle={() => toggleFamilyGroupFolder(family.family_group_id)}
                    expandedFamilyPolicyId={expandedFamilyPolicyId}
                    onToggleFamilyPolicy={toggleFamilyPolicyFolder}
                    expandedCustomerId={expandedCustomerId}
                    onToggleCustomer={toggleFolder}
                    selectedQuoteIds={selectedQuoteIds}
                    toggleSelection={toggleSelection}
                    toggleAllInFolder={toggleAllInFolder}
                    handleBulkProceed={handleBulkProceed}
                    isBulkProceeding={isBulkProceeding}
                    bulkProceedError={bulkProceedError}
                    bulkProceedSuccess={bulkProceedSuccess}
                    openQuote={openQuote}
                  />
                ))}
              </div>
            )}

            {individualGroups.length > 0 && (
              <div className="space-y-3">
                {(organizationGroups.length > 0 || familyGroups.length > 0) && (
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 px-1 pt-1">
                    Individual
                  </p>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {individualGroups.map((group) => (
                    <div
                      key={group.customer_id}
                      className={`flex flex-col border rounded-xl overflow-hidden transition-all duration-200 ${
                        expandedCustomerId === group.customer_id
                          ? "col-span-full border-blue-200 shadow-md ring-1 ring-blue-500/20"
                          : "border-slate-200 shadow-sm hover:shadow-md hover:border-blue-200 bg-white"
                      }`}
                    >
                      <CustomerFolder
                        customer={group}
                        isExpanded={expandedCustomerId === group.customer_id}
                        onToggle={() => toggleFolder(group.customer_id)}
                        selectedQuoteIds={selectedQuoteIds}
                        toggleSelection={toggleSelection}
                        toggleAllInFolder={toggleAllInFolder}
                        handleBulkProceed={handleBulkProceed}
                        isBulkProceeding={isBulkProceeding}
                        bulkProceedError={bulkProceedError}
                        bulkProceedSuccess={bulkProceedSuccess}
                        openQuote={openQuote}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {selectedQuoteId && (
        <QuoteDetailModal
          detail={detail}
          loading={detailLoading}
          error={detailError}
          onClose={closeQuote}
          onStartUnderwriting={async () => {
            if (!detail) return;
            const tenantId = localStorage.getItem("tenant_id");
            if (!tenantId) return;
            const res = await api.post(`/tenants/${tenantId}/cases`, {
              customer_id: detail.customer_id,
              policy_id: detail.policy_id,
              caseType: "Underwriting",
              sourceChannel: "Online",
            });
            const caseId = res.data.caseld;
            router.push(`/case/${caseId}?autoRun=true`);
          }}
        />
      )}
    </div>
  );
}

// ── Shared props for the two lower folder levels ────────────────────────────

interface CustomerFolderHandlers {
  selectedQuoteIds: Set<string>;
  toggleSelection: (quoteId: string) => void;
  toggleAllInFolder: (quoteIds: string[]) => void;
  handleBulkProceed: (quotes: QuoteListItem[]) => void;
  isBulkProceeding: boolean;
  bulkProceedError: string | null;
  bulkProceedSuccess: string | null;
  openQuote: (quoteId: string) => void;
}

// ── Level 1: Organization folder ────────────────────────────────────────────

function OrganizationFolder({
  org,
  isExpanded,
  onToggle,
  expandedPolicyId,
  onTogglePolicy,
  expandedCustomerId,
  onToggleCustomer,
  ...handlers
}: {
  org: OrganizationFolderData;
  isExpanded: boolean;
  onToggle: () => void;
  expandedPolicyId: string | null;
  onTogglePolicy: (policyId: string) => void;
  expandedCustomerId: string | null;
  onToggleCustomer: (customerId: string) => void;
} & CustomerFolderHandlers) {
  const totalEmployees = org.policies.reduce((sum, p) => sum + p.customers.length, 0);

  return (
    <div
      className={`border rounded-xl overflow-hidden transition-all duration-200 ${
        isExpanded ? "border-blue-200 shadow-md ring-1 ring-blue-500/20" : "border-slate-200 shadow-sm hover:shadow-md hover:border-blue-200 bg-white"
      }`}
    >
      <div onClick={onToggle} className={`flex items-center justify-between p-5 cursor-pointer ${isExpanded ? "bg-blue-50/50" : "bg-white"}`}>
        <div className="flex items-center gap-4">
          <div className={`flex items-center justify-center w-12 h-12 rounded-xl ${isExpanded ? "bg-blue-100 text-blue-600" : "bg-slate-100 text-slate-500"} transition-colors`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
              <path d="M6 22V4a2 2 0 012-2h8a2 2 0 012 2v18z" />
              <path d="M6 12H4a2 2 0 00-2 2v8h4" />
              <path d="M18 9h2a2 2 0 012 2v11h-4" />
              <line x1="10" y1="6" x2="14" y2="6" /><line x1="10" y1="10" x2="14" y2="10" />
              <line x1="10" y1="14" x2="14" y2="14" /><line x1="10" y1="18" x2="14" y2="18" />
            </svg>
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-900">{org.organization_name}</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {org.policies.length} master {org.policies.length === 1 ? "policy" : "policies"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${isExpanded ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"}`}>
            {totalEmployees} {totalEmployees === 1 ? "employee" : "employees"}
          </span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`w-5 h-5 text-slate-400 transition-transform duration-200 ${isExpanded ? "rotate-180 text-blue-500" : ""}`}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>

      {isExpanded && (
        <div className="border-t border-slate-100 bg-slate-50/40 p-4 space-y-3">
          {org.policies.map((policy) => (
            <PolicyFolder
              key={policy.master_policy_id}
              policy={policy}
              isExpanded={expandedPolicyId === policy.master_policy_id}
              onToggle={() => onTogglePolicy(policy.master_policy_id)}
              expandedCustomerId={expandedCustomerId}
              onToggleCustomer={onToggleCustomer}
              {...handlers}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Level 2: Master Policy folder ───────────────────────────────────────────

function PolicyFolder({
  policy,
  isExpanded,
  onToggle,
  expandedCustomerId,
  onToggleCustomer,
  ...handlers
}: {
  policy: PolicyFolderData;
  isExpanded: boolean;
  onToggle: () => void;
  expandedCustomerId: string | null;
  onToggleCustomer: (customerId: string) => void;
} & CustomerFolderHandlers) {
  return (
    <div className={`border rounded-lg overflow-hidden bg-white ${isExpanded ? "border-blue-200" : "border-slate-200"}`}>
      <div onClick={onToggle} className={`flex items-center justify-between px-4 py-3 cursor-pointer ${isExpanded ? "bg-blue-50/40" : "hover:bg-slate-50"}`}>
        <div className="flex items-center gap-3">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-slate-400">
            {isExpanded ? (
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            ) : (
              <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path>
            )}
          </svg>
          <div>
            <p className="text-sm font-semibold text-slate-800">Master Policy</p>
            <p className="text-[11px] text-slate-500">{policy.master_policy_label}</p>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="text-[11px] font-semibold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
            {policy.customers.length} {policy.customers.length === 1 ? "employee" : "employees"}
          </span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`w-4 h-4 text-slate-400 transition-transform duration-200 ${isExpanded ? "rotate-180 text-blue-500" : ""}`}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>

      {isExpanded && (
        <div className="border-t border-slate-100 p-3 space-y-2.5 bg-slate-50/30">
          {(() => {
            const allQuotesInPolicy = policy.customers.flatMap(c => c.quotes);
            const selectedInPolicyCount = allQuotesInPolicy.filter(q => handlers.selectedQuoteIds.has(q.quote_id)).length;
            const allSelected = allQuotesInPolicy.length > 0 && selectedInPolicyCount === allQuotesInPolicy.length;
            
            return (
              <div className="px-4 py-3 flex items-center justify-between border border-slate-200 bg-white rounded-lg shadow-sm">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                    checked={allSelected}
                    onChange={() => handlers.toggleAllInFolder(allQuotesInPolicy.map(q => q.quote_id))}
                  />
                  <p className="text-xs font-semibold text-slate-500">
                    {selectedInPolicyCount} of {allQuotesInPolicy.length} plan(s) selected
                  </p>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handlers.handleBulkProceed(allQuotesInPolicy); }}
                  disabled={handlers.isBulkProceeding || selectedInPolicyCount === 0}
                  className="flex items-center gap-2 px-3.5 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 disabled:opacity-50 disabled:bg-slate-400 transition-colors shadow-sm"
                >
                  {handlers.isBulkProceeding ? "Processing..." : "Batch Proceed to Underwriting"}
                </button>
              </div>
            );
          })()}
          {policy.customers.map((customer) => (
            <div
              key={customer.customer_id}
              className={`border rounded-lg overflow-hidden ${expandedCustomerId === customer.customer_id ? "border-blue-200 ring-1 ring-blue-500/10" : "border-slate-200"}`}
            >
              <CustomerFolder
                customer={customer}
                isExpanded={expandedCustomerId === customer.customer_id}
                onToggle={() => onToggleCustomer(customer.customer_id)}
                compact
                {...handlers}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Level 1: Family Group folder ────────────────────────────────────────────

function FamilyGroupFolder({
  family,
  isExpanded,
  onToggle,
  expandedFamilyPolicyId,
  onToggleFamilyPolicy,
  expandedCustomerId,
  onToggleCustomer,
  ...handlers
}: {
  family: FamilyGroupFolderData;
  isExpanded: boolean;
  onToggle: () => void;
  expandedFamilyPolicyId: string | null;
  onToggleFamilyPolicy: (familyPolicyId: string) => void;
  expandedCustomerId: string | null;
  onToggleCustomer: (customerId: string) => void;
} & CustomerFolderHandlers) {
  const totalMembers = family.policies.reduce((sum, p) => sum + p.customers.length, 0);

  return (
    <div
      className={`border rounded-xl overflow-hidden transition-all duration-200 ${
        isExpanded ? "border-rose-200 shadow-md ring-1 ring-rose-500/20" : "border-slate-200 shadow-sm hover:shadow-md hover:border-rose-200 bg-white"
      }`}
    >
      <div onClick={onToggle} className={`flex items-center justify-between p-5 cursor-pointer ${isExpanded ? "bg-rose-50/50" : "bg-white"}`}>
        <div className="flex items-center gap-4">
          <div className={`flex items-center justify-center w-12 h-12 rounded-xl ${isExpanded ? "bg-rose-100 text-rose-600" : "bg-slate-100 text-slate-500"} transition-colors`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
              <path d="M12 3l9 7-9 7-9-7 9-7z" />
              <circle cx="8" cy="17" r="2" /><circle cx="16" cy="17" r="2" />
              <path d="M8 15v-2a4 4 0 018 0v2" />
            </svg>
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-900">{family.family_group_name}</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {family.policies.length} family {family.policies.length === 1 ? "policy" : "policies"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${isExpanded ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-600"}`}>
            {totalMembers} {totalMembers === 1 ? "member" : "members"}
          </span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`w-5 h-5 text-slate-400 transition-transform duration-200 ${isExpanded ? "rotate-180 text-rose-500" : ""}`}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>

      {isExpanded && (
        <div className="border-t border-slate-100 bg-slate-50/40 p-4 space-y-3">
          {family.policies.map((policy) => (
            <FamilyPolicyFolder
              key={policy.family_policy_id}
              policy={policy}
              isExpanded={expandedFamilyPolicyId === policy.family_policy_id}
              onToggle={() => onToggleFamilyPolicy(policy.family_policy_id)}
              expandedCustomerId={expandedCustomerId}
              onToggleCustomer={onToggleCustomer}
              {...handlers}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Level 2: Family Policy folder (Floater or Life Bundle) ─────────────────

function FamilyPolicyFolder({
  policy,
  isExpanded,
  onToggle,
  expandedCustomerId,
  onToggleCustomer,
  ...handlers
}: {
  policy: FamilyPolicyFolderData;
  isExpanded: boolean;
  onToggle: () => void;
  expandedCustomerId: string | null;
  onToggleCustomer: (customerId: string) => void;
} & CustomerFolderHandlers) {
  return (
    <div className={`border rounded-lg overflow-hidden bg-white ${isExpanded ? "border-rose-200" : "border-slate-200"}`}>
      <div onClick={onToggle} className={`flex items-center justify-between px-4 py-3 cursor-pointer ${isExpanded ? "bg-rose-50/40" : "hover:bg-slate-50"}`}>
        <div className="flex items-center gap-3">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-slate-400">
            {isExpanded ? (
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            ) : (
              <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path>
            )}
          </svg>
          <div>
            <p className="text-sm font-semibold text-slate-800">Family Policy</p>
            <p className="text-[11px] text-slate-500">{policy.family_policy_label}</p>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="text-[11px] font-semibold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
            {policy.customers.length} {policy.customers.length === 1 ? "member" : "members"}
          </span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`w-4 h-4 text-slate-400 transition-transform duration-200 ${isExpanded ? "rotate-180 text-rose-500" : ""}`}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>

      {isExpanded && (
        <div className="border-t border-slate-100 p-3 space-y-2.5 bg-slate-50/30">
          {(() => {
            const allQuotesInPolicy = policy.customers.flatMap(c => c.quotes);
            const selectedInPolicyCount = allQuotesInPolicy.filter(q => handlers.selectedQuoteIds.has(q.quote_id)).length;
            const allSelected = allQuotesInPolicy.length > 0 && selectedInPolicyCount === allQuotesInPolicy.length;
            
            return (
              <div className="px-4 py-3 flex items-center justify-between border border-slate-200 bg-white rounded-lg shadow-sm">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                    checked={allSelected}
                    onChange={() => handlers.toggleAllInFolder(allQuotesInPolicy.map(q => q.quote_id))}
                  />
                  <p className="text-xs font-semibold text-slate-500">
                    {selectedInPolicyCount} of {allQuotesInPolicy.length} plan(s) selected
                  </p>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handlers.handleBulkProceed(allQuotesInPolicy); }}
                  disabled={handlers.isBulkProceeding || selectedInPolicyCount === 0}
                  className="flex items-center gap-2 px-3.5 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 disabled:opacity-50 disabled:bg-slate-400 transition-colors shadow-sm"
                >
                  {handlers.isBulkProceeding ? "Processing..." : "Batch Proceed to Underwriting"}
                </button>
              </div>
            );
          })()}
          {policy.customers.map((customer) => (
            <div
              key={customer.customer_id}
              className={`border rounded-lg overflow-hidden ${expandedCustomerId === customer.customer_id ? "border-rose-200 ring-1 ring-rose-500/10" : "border-slate-200"}`}
            >
              <CustomerFolder
                customer={customer}
                isExpanded={expandedCustomerId === customer.customer_id}
                onToggle={() => onToggleCustomer(customer.customer_id)}
                compact
                {...handlers}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Level 3: Customer folder — the shared leaf, used both standalone
// (retail quotes) and nested under a Policy folder (corporate quotes) ──────

function CustomerFolder({
  customer,
  isExpanded,
  onToggle,
  compact,
  selectedQuoteIds,
  toggleSelection,
  toggleAllInFolder,
  handleBulkProceed,
  isBulkProceeding,
  bulkProceedError,
  bulkProceedSuccess,
  openQuote,
}: {
  customer: CustomerFolderData;
  isExpanded: boolean;
  onToggle: () => void;
  compact?: boolean;
} & CustomerFolderHandlers) {
  return (
    <div className="flex flex-col">
      <div
        onClick={onToggle}
        className={`flex items-center justify-between cursor-pointer ${compact ? "p-3" : "p-5"} ${isExpanded ? "bg-blue-50/50" : "bg-white"}`}
      >
        <div className="flex items-center gap-3">
          <div onClick={(e) => e.stopPropagation()} className="flex items-center mr-1">
            <input
              type="checkbox"
              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
              checked={customer.quotes.length > 0 && customer.quotes.every((q) => selectedQuoteIds.has(q.quote_id))}
              onChange={() => toggleAllInFolder(customer.quotes.map((q) => q.quote_id))}
            />
          </div>
          <div className={`flex items-center justify-center rounded-lg ${compact ? "w-9 h-9" : "w-12 h-12 rounded-xl"} ${isExpanded ? "bg-blue-100 text-blue-600" : "bg-slate-100 text-slate-500"} transition-colors`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={compact ? "w-4 h-4" : "w-6 h-6"}>
              {isExpanded ? (
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              ) : (
                <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path>
              )}
            </svg>
          </div>
          <div>
            <h3 className={`font-bold text-slate-900 ${compact ? "text-sm" : "text-base"}`}>{customer.customer_name}</h3>
            <p className="text-xs text-slate-500 font-mono mt-0.5">{customer.customer_cnic}</p>
            {customer.quotes[0]?.acquisition_source_name && (
              <p className="text-[11px] text-slate-400 mt-1">
                Lead Generated by{" "}
                <span className="font-semibold text-slate-600">{customer.quotes[0].acquisition_source_name}</span>
                <span className="ml-1.5 inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-600 border border-slate-200">
                  {SOURCE_TYPE_LABELS[customer.quotes[0].acquisition_source_type ?? ""] ?? customer.quotes[0].acquisition_source_type}
                </span>
                {customer.quotes[0].acquisition_source_partner && (
                  <span className="ml-1 text-slate-400">· {customer.quotes[0].acquisition_source_partner}</span>
                )}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${isExpanded ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"}`}>
            {customer.quotes.length} {customer.quotes.length === 1 ? "Plan" : "Plans"}
          </span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`text-slate-400 transition-transform duration-200 ${compact ? "w-4 h-4" : "w-5 h-5"} ${isExpanded ? "rotate-180 text-blue-500" : ""}`}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>

      {isExpanded && (
        <div className="border-t border-slate-100 bg-white">
          {bulkProceedError && (
            <div className="mx-4 mt-4 bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-xs text-red-600">{bulkProceedError}</p>
            </div>
          )}
          {bulkProceedSuccess && (
            <div className="mx-4 mt-4 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
              <p className="text-xs text-emerald-700 font-semibold">Success</p>
              <p className="text-xs text-emerald-600">{bulkProceedSuccess}</p>
            </div>
          )}

          <div className="px-5 py-3 flex items-center justify-between border-b border-slate-100 bg-slate-50/50">
            <p className="text-xs font-semibold text-slate-500">
              {customer.quotes.filter((q) => selectedQuoteIds.has(q.quote_id)).length} plan(s) selected
            </p>
            <button
              onClick={(e) => { e.stopPropagation(); handleBulkProceed(customer.quotes); }}
              disabled={isBulkProceeding || customer.quotes.filter((q) => selectedQuoteIds.has(q.quote_id)).length === 0}
              className="flex items-center gap-2 px-3.5 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 disabled:opacity-50 disabled:bg-slate-400 transition-colors shadow-sm"
            >
              {isBulkProceeding && <span className="animate-spin h-3 w-3 rounded-full border-2 border-white/30 border-t-white" />}
              {isBulkProceeding ? "Processing..." : "Proceed to Underwriting"}
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-5 py-3 text-left w-12">
                    <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                        checked={customer.quotes.length > 0 && customer.quotes.every((q) => selectedQuoteIds.has(q.quote_id))}
                        onChange={() => toggleAllInFolder(customer.quotes.map((q) => q.quote_id))}
                      />
                    </div>
                  </th>
                  <th className="px-2 py-3 text-left">Plan</th>
                  <th className="px-5 py-3 text-right">Coverage</th>
                  <th className="px-5 py-3 text-center">Term</th>
                  <th className="px-5 py-3 text-right">Expected Premium</th>
                  <th className="px-5 py-3 text-right">Risk</th>
                  <th className="px-5 py-3 text-right">Total payable</th>
                  <th className="px-5 py-3 text-left">Generated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {customer.quotes.map((row) => (
                  <tr
                    key={row.quote_id}
                    onClick={() => openQuote(row.quote_id)}
                    className={`transition-colors cursor-pointer ${selectedQuoteIds.has(row.quote_id) ? "bg-blue-50/40" : "hover:bg-slate-50"}`}
                  >
                    <td className="px-5 py-3.5" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center">
                        <input
                          type="checkbox"
                          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                          checked={selectedQuoteIds.has(row.quote_id)}
                          onChange={() => toggleSelection(row.quote_id)}
                        />
                      </div>
                    </td>
                    <td className="px-2 py-3.5">
                      <p className="text-slate-700 font-medium">{row.plan_label}</p>
                      <span className="inline-flex mt-0.5 px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-100">
                        {INSURANCE_TYPE_LABELS[row.insurance_type] ?? row.insurance_type}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-right font-medium text-slate-700">{formatPKR(row.coverage_amount)}</td>
                    <td className="px-5 py-3.5 text-center text-slate-600">{row.term_years}y</td>
                    <td className="px-5 py-3.5 text-right text-slate-600">{formatPKR(row.base_premium)}</td>
                    <td className="px-5 py-3.5 text-right text-slate-600">{formatPKR(row.loading_applied)}</td>
                    <td className="px-5 py-3.5 text-right font-bold text-slate-900">{formatPKR(row.total_premium)}</td>
                    <td className="px-5 py-3.5 text-slate-500 text-xs whitespace-nowrap">
                      {new Date(row.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Detail modal ─────────────────────────────────────────────────────────────

function QuoteDetailModal({
  detail, loading, error, onClose, onStartUnderwriting,
}: {
  detail: QuoteDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onStartUnderwriting: () => Promise<void>;
}) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const handleStart = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await onStartUnderwriting();
    } catch (err: any) {
      setStartError(err.message ?? "Failed to start underwriting.");
      setStarting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 flex items-start justify-center overflow-y-auto py-10 px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl border border-slate-200 shadow-xl w-full max-w-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-700">Proposal Details</p>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {loading && (
          <div className="py-16 flex flex-col items-center justify-center gap-2">
            <div className="animate-spin h-7 w-7 text-blue-500 rounded-full border-2 border-slate-100 border-t-blue-500" />
            <span className="text-xs text-slate-400">Loading details…</span>
          </div>
        )}

        {error && (
          <div className="p-5">
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-xs font-bold text-red-700 uppercase tracking-widest mb-1">Error</p>
              <p className="text-xs text-red-600">{error}</p>
            </div>
          </div>
        )}

        {detail && !loading && (
          <div className="p-5 space-y-5">
            {/* Proposal Statement */}
            <div className="rounded-xl border border-blue-100 bg-blue-50/60 px-5 py-4 space-y-1.5">
              <div className="flex items-center justify-between mb-1">
                <p className="text-[10px] font-bold uppercase tracking-widest text-blue-500">Proposal Statement</p>
                <span className="text-[10px] font-mono text-slate-400">Ref: {detail.quote_id.slice(0, 8).toUpperCase()}</span>
              </div>
              {detail.organization_name && (
                <p className="text-[11px] text-blue-600 font-semibold">
                  Corporate — {detail.organization_name}
                  {detail.master_policy_label ? ` · ${detail.master_policy_label}` : ""}
                </p>
              )}
              {detail.family_group_name && (
                <p className="text-[11px] text-rose-600 font-semibold">
                  Family — {detail.family_group_name}
                  {detail.family_policy_label ? ` · ${detail.family_policy_label}` : ""}
                </p>
              )}
              <p className="text-sm text-slate-700 leading-relaxed">
                We are pleased to present the following insurance proposal for{" "}
                <span className="font-semibold text-slate-900">{detail.customer_name}</span>. Based on the
                information provided, we propose a{" "}
                <span className="font-semibold text-slate-900">
                  {INSURANCE_TYPE_LABELS[detail.insurance_type] ?? detail.insurance_type}
                </span>{" "}
                policy under the{" "}
                <span className="font-semibold text-slate-900">{detail.plan_label}</span>{" "}
                plan, providing a sum assured of{" "}
                <span className="font-semibold text-slate-900">{formatPKR(detail.coverage_amount)}</span>{" "}
                over a term of{" "}
                <span className="font-semibold text-slate-900">{detail.term_years} years</span>.
              </p>
              <p className="text-sm text-slate-700 leading-relaxed">
                The total annual premium for this coverage is{" "}
                <span className="font-bold text-slate-900">{formatPKR(detail.total_premium)}</span>{" "}
                (expected premium of {formatPKR(detail.base_premium)} plus a risk of{" "}
                {formatPKR(detail.loading_applied)}). This proposal is valid subject to
                satisfactory underwriting assessment and is generated as of{" "}
                <span className="font-medium text-slate-800">{formatDate(detail.created_at)}</span>.
              </p>
            </div>

            <p className="text-[11px] text-slate-500 mt-1 mb-2 text-center italic">
              Opens an Underwriting case for this customer on this exact proposal — documents, AI risk scoring, and the final decision all happen there.
            </p>

            {/* Headline */}
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-900">{detail.customer_name}</h2>
                <p className="text-xs text-slate-400">{detail.customer_cnic}</p>
              </div>
              <p className="text-[11px] text-slate-400 text-right mt-1.5">
                Rate version {detail.rate_version} · Generated {new Date(detail.created_at).toLocaleString()}
              </p>
            </div>

            {/* Customer */}
            <section>
              <SectionLabel>Customer</SectionLabel>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <DetailField label="Date of Birth" value={`${formatDate(detail.customer_dob)} (${detail.customer_age} yrs)`} />
                <DetailField label="Gender" value={detail.customer_gender} />
                <DetailField label="Occupation" value={detail.customer_occupation} />
                <DetailField label="Annual Income" value={formatPKR(detail.customer_declared_income)} />
                <DetailField label="Smoker" value={detail.customer_is_smoker ? "Yes" : "No"} />
                <DetailField
                  label="Height / Weight"
                  value={`${detail.customer_height_cm} cm / ${detail.customer_weight_kg} kg${detail.customer_bmi ? ` (BMI ${detail.customer_bmi})` : ""}`}
                />
                {detail.acquisition_source_name && (
                  <DetailField
                    label="Lead Generated By"
                    value={`${detail.acquisition_source_name} (${SOURCE_TYPE_LABELS[detail.acquisition_source_type ?? ""] ?? detail.acquisition_source_type ?? ""})${detail.acquisition_source_partner ? ` — ${detail.acquisition_source_partner}` : ""}`}
                  />
                )}
              </div>
            </section>

            {/* Policy */}
            <section>
              <SectionLabel>Policy</SectionLabel>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <DetailField label="Plan" value={detail.plan_label} />
                <DetailField label="Type" value={INSURANCE_TYPE_LABELS[detail.insurance_type] ?? detail.insurance_type} />
                <DetailField label="Coverage" value={formatPKR(detail.coverage_amount)} />
                <DetailField label="Term" value={`${detail.term_years} years`} />
                {detail.organization_name && <DetailField label="Organization" value={detail.organization_name} />}
                {detail.master_policy_label && <DetailField label="Master Policy" value={detail.master_policy_label} />}
                {detail.family_group_name && <DetailField label="Family" value={detail.family_group_name} />}
                {detail.family_policy_label && <DetailField label="Family Policy" value={detail.family_policy_label} />}
                {detail.nominee_name && <DetailField label="Nominee" value={`${detail.nominee_name}${detail.nominee_relationship ? ` (${detail.nominee_relationship})` : ""}`} />}
                {detail.dependent_name && <DetailField label="Dependent" value={`${detail.dependent_name}${detail.dependent_dob ? ` — b. ${formatDate(detail.dependent_dob)}` : ""}`} />}
              </div>
            </section>

            {/* Premium breakdown */}
            <section>
              <SectionLabel>Premium Breakdown</SectionLabel>
              <div className="grid grid-cols-3 gap-3">
                <StatTile label="Premium" value={formatPKR(detail.base_premium)} />
                {/* <StatTile label="Risk" value={formatPKR(detail.loading_applied)} /> */}
                <StatTile
                  label="Total Payable"
                  value={
                    <span>
                      {formatPKR(detail.total_premium)}{" "}
                      <span className="text-[10px] font-medium text-slate-300"></span>
                    </span>
                  }
                  highlight
                />
              </div>
            </section>

            {/* Proceed to underwriting */}
            <section className="pt-1 border-t border-slate-100">
              {startError && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{startError}</p>
              )}
              <button
                onClick={handleStart}
                disabled={starting}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-900 text-white rounded-lg text-sm font-semibold hover:bg-slate-800 disabled:opacity-50 transition-colors"
              >
                {starting ? (
                  <span className="animate-spin h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white" />
                ) : null}
                {starting ? "Opening case…" : "Proceed to Underwriting"}
              </button>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2.5">{children}</p>;
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wide mb-0.5">{label}</p>
      <p className="text-sm text-slate-700 font-medium">{value}</p>
    </div>
  );
}

function StatTile({ label, value, highlight }: { label: string; value: React.ReactNode; highlight?: boolean }) {
  return (
    <div className={`rounded-lg p-3 ${highlight ? "bg-slate-900" : "bg-slate-50"}`}>
      <p className={`text-[10px] font-bold uppercase tracking-widest mb-1 ${highlight ? "text-slate-300" : "text-slate-400"}`}>
        {label}
      </p>
      <p className={`text-sm font-bold ${highlight ? "text-white" : "text-slate-800"}`}>{value}</p>
    </div>
  );
}
