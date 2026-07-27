import re

def fix_leads():
    with open('frontend/app/admin/leads/page.tsx', 'r') as f:
        content = f.read()

    # Find the return statement
    return_idx = content.find("  return (\n    <div className=\"px-6 py-5")
    if return_idx == -1: return_idx = content.find("  return (\n    <div className=")

    injection = "  const filteredLeads = getFilteredLeads();\n\n"
    content = content[:return_idx] + injection + content[return_idx:]

    content = content.replace("{leads.length}", "{filteredLeads.length}")
    content = content.replace("leads.filter(l => l.type === \"INDIVIDUAL\").length", "filteredLeads.filter(l => l.type === \"INDIVIDUAL\").length")
    content = content.replace("leads.filter(l => l.type === \"FAMILY\").length", "filteredLeads.filter(l => l.type === \"FAMILY\").length")
    content = content.replace("leads.filter(l => l.type === \"CORPORATE\").length", "filteredLeads.filter(l => l.type === \"CORPORATE\").length")

    with open('frontend/app/admin/leads/page.tsx', 'w') as f:
        f.write(content)


def fix_policyholders():
    with open('frontend/app/admin/policyholders/page.tsx', 'r') as f:
        content = f.read()

    return_idx = content.find("  return (\n    <div className=\"px-6 py-5")
    if return_idx == -1: return_idx = content.find("  return (\n    <div className=")

    injection = "  const filteredPolicyholders = getFilteredData();\n\n"
    content = content[:return_idx] + injection + content[return_idx:]

    content = content.replace("{policyholders.length}", "{filteredPolicyholders.length}")
    content = content.replace("policyholders.filter(p => p.type === \"INDIVIDUAL\").length", "filteredPolicyholders.filter(p => p.type === \"INDIVIDUAL\").length")
    content = content.replace("policyholders.filter(p => p.type === \"FAMILY\").length", "filteredPolicyholders.filter(p => p.type === \"FAMILY\").length")
    content = content.replace("policyholders.filter(p => p.type === \"CORPORATE\").length", "filteredPolicyholders.filter(p => p.type === \"CORPORATE\").length")

    with open('frontend/app/admin/policyholders/page.tsx', 'w') as f:
        f.write(content)


def fix_proposal():
    with open('frontend/app/proposal/page.tsx', 'r') as f:
        content = f.read()

    # The stats are inside a useMemo
    stats_memo = r"""  const stats = useMemo\(\(\) => \{
    const totalCoverage = segmentQuotes.reduce\(\(sum, q\) => sum \+ q.coverage_amount, 0\);
    const totalPremium = segmentQuotes.reduce\(\(sum, q\) => sum \+ q.total_premium, 0\);
    
    return \[
      \{ title: "Proposals", value: segmentQuotes.length, subtitle: "plans generated", accent: "slate" as const \},
      \{ title: "Total Coverage", value: segmentQuotes.length \? fmtCoverage\(totalCoverage\) : "—", subtitle: "sum assured", accent: "amber" as const \},
      \{ title: "Total Premium", value: segmentQuotes.length \? fmtCoverage\(totalPremium\) : "—", subtitle: "annualized", accent: "emerald" as const \},
    \];
  \}, \[segmentQuotes\]\);"""

    new_stats_memo = """  const stats = useMemo(() => {
    // Determine the fully filtered list by applying the search filter if present.
    // This ensures stats match exactly what's visible on the screen.
    let fullyFilteredList = segmentQuotes;
    if (search) {
      fullyFilteredList = segmentQuotes.filter(
        (q) =>
          q.customer_name?.toLowerCase().includes(search.toLowerCase()) ||
          q.policy_name?.toLowerCase().includes(search.toLowerCase())
      );
    }
    const totalCoverage = fullyFilteredList.reduce((sum, q) => sum + q.coverage_amount, 0);
    const totalPremium = fullyFilteredList.reduce((sum, q) => sum + q.total_premium, 0);
    
    return [
      { title: "Proposals", value: fullyFilteredList.length, subtitle: "plans generated", accent: "slate" as const },
      { title: "Total Coverage", value: fullyFilteredList.length > 0 ? fmtCoverage(totalCoverage) : "—", subtitle: "sum assured", accent: "amber" as const },
      { title: "Total Premium", value: fullyFilteredList.length > 0 ? fmtCoverage(totalPremium) : "—", subtitle: "annualized", accent: "emerald" as const },
    ];
  }, [segmentQuotes, search]);"""

    content = re.sub(stats_memo, new_stats_memo, content, flags=re.MULTILINE)
    
    with open('frontend/app/proposal/page.tsx', 'w') as f:
        f.write(content)


def fix_underwriting():
    with open('frontend/app/underwriting/page.tsx', 'r') as f:
        content = f.read()

    # The stats are inside useMemo
    stats_memo = r"""  const stats = useMemo\(\(\) => \{
    if \(!segmentCases\) return \[\];
    const pendingDocs = segmentCases.filter\(c => c.caseStatus === "Pending Documents"\).length;
    const underReview = segmentCases.filter\(c => c.caseStatus === "Under Review" || c.caseStatus === "New" || c.caseStatus === "InProgress"\).length;
    const approved = segmentCases.filter\(c => c.caseStatus === "Approved"\).length;
    const customerCount = new Set\(segmentCases.map\(c => c.customer_id\)\).size;

    return \[
      \{ title: "Cases", value: segmentCases.length, subtitle: "total cases", accent: "blue" as const \},
      \{ title: "Pending", value: pendingDocs, subtitle: "awaiting docs", accent: "amber" as const \},
      \{ title: "In Review", value: underReview, subtitle: "underwriting", accent: "slate" as const \},
      \{ title: "Approved", value: approved, subtitle: "ready for issuance", accent: "emerald" as const \},
    \];
  \}, \[segmentCases\]\);"""

    new_stats_memo = """  const stats = useMemo(() => {
    if (!segmentCases) return [];
    
    // Apply the same search filter to the stats so they match the visible cards
    let fullyFilteredCases = segmentCases;
    if (search) {
      fullyFilteredCases = segmentCases.filter(c =>
        c.customer_name?.toLowerCase().includes(search.toLowerCase()) ||
        c.customer_id?.toLowerCase().includes(search.toLowerCase()) ||
        c.product_name?.toLowerCase().includes(search.toLowerCase())
      );
    }

    const pendingDocs = fullyFilteredCases.filter(c => c.caseStatus === "Pending Documents").length;
    const underReview = fullyFilteredCases.filter(c => c.caseStatus === "Under Review" || c.caseStatus === "New" || c.caseStatus === "InProgress").length;
    const approved = fullyFilteredCases.filter(c => c.caseStatus === "Approved").length;

    return [
      { title: "Cases", value: fullyFilteredCases.length, subtitle: "total cases", accent: "blue" as const },
      { title: "Pending", value: pendingDocs, subtitle: "awaiting docs", accent: "amber" as const },
      { title: "In Review", value: underReview, subtitle: "underwriting", accent: "slate" as const },
      { title: "Approved", value: approved, subtitle: "ready for issuance", accent: "emerald" as const },
    ];
  }, [segmentCases, search]);"""

    content = re.sub(stats_memo, new_stats_memo, content, flags=re.MULTILINE)
    
    with open('frontend/app/underwriting/page.tsx', 'w') as f:
        f.write(content)

try:
    fix_leads()
    print("Fixed leads.")
except Exception as e: print(f"Error leads: {e}")

try:
    fix_policyholders()
    print("Fixed policyholders.")
except Exception as e: print(f"Error policyholders: {e}")

try:
    fix_proposal()
    print("Fixed proposal.")
except Exception as e: print(f"Error proposal: {e}")

try:
    fix_underwriting()
    print("Fixed underwriting.")
except Exception as e: print(f"Error underwriting: {e}")

