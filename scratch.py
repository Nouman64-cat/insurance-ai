import sys

def replace_all():
    with open("frontend/app/proposal/page.tsx", "r") as f:
        content = f.read()
    
    # 1. Remove Customers Stat Tile (Line 352)
    kpi_old = '      { title: "Customers", value: customerCount, subtitle: "in this view", accent: "blue" as const },\n'
    content = content.replace(kpi_old, "")
    
    customer_count_old = '    const customerCount = new Set(segmentQuotes.map((q) => q.customer_id)).size;\n'
    content = content.replace(customer_count_old, "")

    # 2. Add viewMode state
    state_old = '  const [expandedCustomerId, setExpandedCustomerId] = useState<string | null>(null);'
    state_new = "  const [viewMode, setViewMode] = useState<'list'|'grid'>('list');"
    content = content.replace(state_old, state_new)
    
    toggle_old = """  const toggleFolder = (customerId: string) => {
    setExpandedCustomerId((prev) => (prev === customerId ? null : customerId));
  };"""
    content = content.replace(toggle_old, "")
    
    content = content.replace("    setExpandedCustomerId(null);\n", "")

    # 3. Add toggle UI (Top bar)
    search_bar_old = """      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap flex-1 min-w-0">
          <input"""
    search_bar_new = """      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap flex-1 min-w-0">
          <div className="inline-flex bg-slate-100/80 p-1 rounded-xl shadow-inner border border-slate-200/60 mr-2 shrink-0">
            <button
              onClick={() => setViewMode("list")}
              title="List View"
              className={`p-2 rounded-lg transition-all ${viewMode === "list" ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>
            </button>
            <button
              onClick={() => setViewMode("grid")}
              title="Grid View"
              className={`p-2 rounded-lg transition-all ${viewMode === "grid" ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg>
            </button>
          </div>
          <input"""
    content = content.replace(search_bar_old, search_bar_new)

    # 4. Update handlers in QuotePage
    quote_open_old = "                      openQuote={openQuote}\n                    />"
    quote_open_new = "                      openQuote={openQuote}\n                      viewMode={viewMode}\n                    />"
    # Actually wait, let's just replace all instances of openQuote={openQuote} passing to folders
    
    # 5. Fix individualGroups UI
    indiv_old = """                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {individualGroups.map((group) => (
                    <div
                      key={group.customer_id}
                      className={`flex flex-col border rounded-xl overflow-hidden transition-all duration-200 ${expandedCustomerId === group.customer_id
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
                </div>"""
    indiv_new = """                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                  {(() => {
                    const allIndividualQuotes = individualGroups.flatMap(g => g.quotes);
                    const selectedIndividualCount = allIndividualQuotes.filter(q => selectedQuoteIds.has(q.quote_id)).length;
                    const allSelected = allIndividualQuotes.length > 0 && selectedIndividualCount === allIndividualQuotes.length;
                    return (
                      <div className="flex flex-col">
                        <div className="px-4 py-3 flex items-center justify-between border-b border-slate-200 bg-slate-50/50">
                          <div className="flex items-center gap-3">
                            <input
                              type="checkbox"
                              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                              checked={allSelected}
                              onChange={() => toggleAllInFolder(allIndividualQuotes.map(q => q.quote_id))}
                            />
                            <p className="text-xs font-semibold text-slate-500">
                              {selectedIndividualCount} of {allIndividualQuotes.length} plan(s) selected
                            </p>
                          </div>
                          <button
                            onClick={() => handleBulkProceed(allIndividualQuotes)}
                            disabled={isBulkProceeding || selectedIndividualCount === 0}
                            className="flex items-center gap-2 px-3.5 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 disabled:opacity-50 disabled:bg-slate-400 transition-colors shadow-sm"
                          >
                            {isBulkProceeding ? "Processing..." : "Batch Proceed to Underwriting"}
                          </button>
                        </div>
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
                        {viewMode === 'grid' ? (
                          <div className="p-4 bg-slate-50/30">
                            <ProposalsGrid
                              quotes={allIndividualQuotes}
                              selectedQuoteIds={selectedQuoteIds}
                              toggleSelection={toggleSelection}
                              toggleAllInFolder={toggleAllInFolder}
                              openQuote={openQuote}
                            />
                          </div>
                        ) : (
                          <ProposalsTable
                            quotes={allIndividualQuotes}
                            selectedQuoteIds={selectedQuoteIds}
                            toggleSelection={toggleSelection}
                            toggleAllInFolder={toggleAllInFolder}
                            openQuote={openQuote}
                          />
                        )}
                      </div>
                    );
                  })()}
                </div>"""
    content = content.replace(indiv_old, indiv_new)

    # Replace CustomerFolder props down the tree
    props_to_remove = [
        "expandedCustomerId={expandedCustomerId}\n",
        "onToggleCustomer={toggleFolder}\n",
        "expandedCustomerId={expandedCustomerId}\n",
        "onToggleCustomer={onToggleCustomer}\n",
        "expandedCustomerId,\n",
        "onToggleCustomer,\n",
        "expandedCustomerId: string | null;\n",
        "onToggleCustomer: (customerId: string) => void;\n",
    ]
    for p in props_to_remove:
        content = content.replace(p, "")
        
    content = content.replace("openQuote={openQuote}", "openQuote={openQuote}\n                        viewMode={viewMode}")

    # Add viewMode to CustomerFolderHandlers
    content = content.replace(
        "interface CustomerFolderHandlers {",
        "interface CustomerFolderHandlers {\n  viewMode: 'list' | 'grid';"
    )

    # PolicyFolder customers map
    policy_map_old = """          {policy.customers.map((customer) => (
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
          ))}"""
    policy_map_new = """          <div className="mt-3">
            {handlers.viewMode === 'grid' ? (
              <ProposalsGrid
                quotes={policy.customers.flatMap(c => c.quotes)}
                selectedQuoteIds={handlers.selectedQuoteIds}
                toggleSelection={handlers.toggleSelection}
                toggleAllInFolder={handlers.toggleAllInFolder}
                openQuote={handlers.openQuote}
              />
            ) : (
              <ProposalsTable
                quotes={policy.customers.flatMap(c => c.quotes)}
                selectedQuoteIds={handlers.selectedQuoteIds}
                toggleSelection={handlers.toggleSelection}
                toggleAllInFolder={handlers.toggleAllInFolder}
                openQuote={handlers.openQuote}
              />
            )}
          </div>"""
    content = content.replace(policy_map_old, policy_map_new)
    
    # FamilyPolicyFolder customers map
    family_policy_map_old = """          {policy.customers.map((customer) => (
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
          ))}"""
    
    content = content.replace(family_policy_map_old, policy_map_new)

    # 6. Replace CustomerFolder with ProposalsTable and ProposalsGrid
    cf_start = content.find("function CustomerFolder({")
    cf_end = content.find("// ── Detail modal", cf_start)
    if cf_start != -1 and cf_end != -1:
        proposals_components = """// ── Level 3: Proposals Views ───────────────────────────────────────────────────

function ProposalsTable({
  quotes,
  selectedQuoteIds,
  toggleSelection,
  toggleAllInFolder,
  openQuote,
}: {
  quotes: QuoteListItem[];
  selectedQuoteIds: Set<string>;
  toggleSelection: (quoteId: string) => void;
  toggleAllInFolder: (quoteIds: string[]) => void;
  openQuote: (quoteId: string) => void;
}) {
  if (quotes.length === 0) return null;
  const allSelected = quotes.length > 0 && quotes.every(q => selectedQuoteIds.has(q.quote_id));

  return (
    <div className="overflow-x-auto bg-white w-full border-t border-slate-100">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <th className="px-5 py-3 text-left w-12">
              <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                  checked={allSelected}
                  onChange={() => toggleAllInFolder(quotes.map(q => q.quote_id))}
                />
              </div>
            </th>
            <th className="px-5 py-3 text-left">Customer</th>
            <th className="px-2 py-3 text-left">Plan</th>
            <th className="px-5 py-3 text-right">Coverage</th>
            <th className="px-5 py-3 text-center">Term</th>
            <th className="px-5 py-3 text-right">Premium</th>
            <th className="px-5 py-3 text-right">Risk</th>
            <th className="px-5 py-3 text-right">Total</th>
            <th className="px-5 py-3 text-left">Generated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {quotes.map((row) => (
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
              <td className="px-5 py-3.5">
                <p className="text-slate-900 font-bold truncate max-w-[150px]" title={row.customer_name}>{row.customer_name}</p>
                <p className="text-slate-500 text-[10px] font-mono">{row.customer_cnic}</p>
                {row.acquisition_source_name && (
                  <p className="text-[10px] text-slate-400 mt-0.5 truncate max-w-[150px]" title={row.acquisition_source_name}>
                    {row.acquisition_source_name}
                  </p>
                )}
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
  );
}

function ProposalsGrid({
  quotes,
  selectedQuoteIds,
  toggleSelection,
  openQuote,
}: {
  quotes: QuoteListItem[];
  selectedQuoteIds: Set<string>;
  toggleSelection: (quoteId: string) => void;
  toggleAllInFolder: (quoteIds: string[]) => void;
  openQuote: (quoteId: string) => void;
}) {
  if (quotes.length === 0) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 p-4">
      {quotes.map((row) => (
        <div
          key={row.quote_id}
          onClick={() => openQuote(row.quote_id)}
          className={`relative border rounded-xl p-4 flex flex-col gap-3 cursor-pointer transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg bg-white ${selectedQuoteIds.has(row.quote_id) ? "border-blue-300 ring-1 ring-blue-400/20 shadow-md" : "border-slate-200 shadow-sm"}`}
        >
          <div className="absolute top-3 right-3 z-10" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
              checked={selectedQuoteIds.has(row.quote_id)}
              onChange={() => toggleSelection(row.quote_id)}
            />
          </div>
          
          <div className="pr-6">
            <h4 className="font-bold text-slate-900 truncate">{row.customer_name}</h4>
            <p className="text-xs text-slate-500 font-mono mt-0.5">{row.customer_cnic}</p>
          </div>
          
          <div className="bg-slate-50 rounded-lg p-2.5 border border-slate-100 flex items-center justify-between">
            <div className="min-w-0 pr-2">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Plan</p>
              <p className="text-xs font-semibold text-slate-700 truncate">{row.plan_label}</p>
            </div>
            <span className="flex-shrink-0 inline-flex px-1.5 py-0.5 rounded-[4px] text-[9px] font-bold bg-blue-100 text-blue-700 border border-blue-200">
              {INSURANCE_TYPE_LABELS[row.insurance_type] ?? row.insurance_type}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 mt-auto pt-2 border-t border-slate-100">
            <div>
              <p className="text-[10px] font-medium text-slate-500">Coverage</p>
              <p className="text-sm font-semibold text-slate-800">{formatPKR(row.coverage_amount)}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] font-medium text-slate-500">Premium</p>
              <p className="text-sm font-bold text-emerald-600">{formatPKR(row.total_premium)}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

"""
        content = content[:cf_start] + proposals_components + "\n" + content[cf_end:]

    with open("frontend/app/proposal/page.tsx", "w") as f:
        f.write(content)

replace_all()
