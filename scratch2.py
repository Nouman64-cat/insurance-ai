import re

with open("frontend/app/proposal/page.tsx", "r") as f:
    code = f.read()

# 1. Add agent/acquisition source imports
imports = """
import { updateQuote } from "../services/quotes";
import { listUnderwriters, Agent } from "../services/agents";
import { listAcquisitionSources, AcquisitionSource } from "../services/acquisitionSources";
"""
code = code.replace('import { fmtCoverage } from "@/lib/mock-data";\n', 'import { fmtCoverage } from "@/lib/mock-data";\n' + imports)

# 2. Add Status Mapping
status_mapping = """
const STATUS_TABS = [
  { id: "ALL", label: "All Proposals" },
  { id: "Quoted", label: "Draft" },
  { id: "Proposed", label: "Submitted" },
  { id: "UnderReview", label: "Under Review" },
  { id: "InformationRequested", label: "Info Requested" },
  { id: "Approved", label: "Approved" },
  { id: "Declined", label: "Rejected" },
  { id: "Issued", label: "Issued" },
];

const STORAGE_KEY = "proposal_view_state";
"""
code = code.replace('// ── Grouping types', status_mapping + '\n// ── Grouping types')

# 3. Inject states inside QuotePage
states_injection = """
  // Sticky State
  const [activeTab, setActiveTab] = useState("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [agentFilter, setAgentFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [underwriters, setUnderwriters] = useState<Agent[]>([]);
  const [sources, setSources] = useState<AcquisitionSource[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.activeTab) setActiveTab(parsed.activeTab);
        if (parsed.dateFrom) setDateFrom(parsed.dateFrom);
        if (parsed.dateTo) setDateTo(parsed.dateTo);
        if (parsed.agentFilter) setAgentFilter(parsed.agentFilter);
        if (parsed.sourceFilter) setSourceFilter(parsed.sourceFilter);
      } catch (e) {}
    }
    const tenantId = localStorage.getItem("tenant_id");
    if (tenantId) {
      listUnderwriters(tenantId).then(setUnderwriters).catch(console.error);
      listAcquisitionSources(tenantId).then(setSources).catch(console.error);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ activeTab, dateFrom, dateTo, agentFilter, sourceFilter }));
  }, [activeTab, dateFrom, dateTo, agentFilter, sourceFilter]);

"""
code = code.replace('const [segment, setSegment] = useState<SegmentFilter>("all");\n', 'const [segment, setSegment] = useState<SegmentFilter>("all");\n' + states_injection)

# 4. Modify fetchQuotes to use filters
fetch_injection = """
  const fetchQuotes = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const filters: any = {};
      if (activeTab !== "ALL") filters.status = activeTab;
      if (dateFrom) filters.created_from = dateFrom;
      if (dateTo) filters.created_to = dateTo;
      if (agentFilter) filters.assigned_underwriter_id = agentFilter;
      if (sourceFilter) filters.acquisition_source_id = sourceFilter;
      
      const data = await listQuotes(filters);
      setQuotes(data);
    } catch (err: any) {
      setError(err.message ?? "Failed to load quotations.");
    } finally {
      setLoading(false);
    }
  }, [activeTab, dateFrom, dateTo, agentFilter, sourceFilter]);
"""
code = re.sub(r'const fetchQuotes = useCallback\(async \(\) => \{.*?\}, \[\]\);', fetch_injection.strip(), code, flags=re.DOTALL)

# 5. Insert tabs and filters in the UI
ui_injection = """
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-1 border-b border-slate-200">
          {STATUS_TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${activeTab === tab.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <button onClick={() => setFiltersOpen(!filtersOpen)} className="px-3 py-1.5 text-xs font-semibold border border-slate-200 rounded-lg hover:bg-slate-50">
            {filtersOpen ? 'Hide Filters' : 'Show Advanced Filters'}
          </button>
          {filtersOpen && (
            <div className="flex flex-wrap gap-3 p-3 bg-slate-50 border border-slate-200 rounded-xl w-full">
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="text-xs border border-slate-200 rounded px-2 py-1" title="Created From" />
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="text-xs border border-slate-200 rounded px-2 py-1" title="Created To" />
              <select value={agentFilter} onChange={e => setAgentFilter(e.target.value)} className="text-xs border border-slate-200 rounded px-2 py-1">
                <option value="">All Underwriters</option>
                {underwriters.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
              <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} className="text-xs border border-slate-200 rounded px-2 py-1">
                <option value="">All Sources</option>
                {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
        </div>
      </div>
"""
code = code.replace('<div className="flex items-center justify-between gap-3 flex-wrap">', ui_injection + '\n      <div className="flex items-center justify-between gap-3 flex-wrap">')

with open("frontend/app/proposal/page.tsx", "w") as f:
    f.write(code)
print("success")
