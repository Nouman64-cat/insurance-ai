import re

with open("frontend/app/proposal/page.tsx", "r") as f:
    text = f.read()

# Replace organizationGroups rendering
org_search = r'\{organizationGroups\.map\(\(org\) => \([\s\S]*?viewMode=\{viewMode\}\s*\/>\s*\)\)\}'
org_replace = """{(() => {
                  const allOrgQuotes = organizationGroups.flatMap(org => org.policies.flatMap(p => p.customers.flatMap(c => c.quotes)));
                  const selectedOrgCount = allOrgQuotes.filter(q => selectedQuoteIds.has(q.quote_id)).length;
                  const allSelected = allOrgQuotes.length > 0 && selectedOrgCount === allOrgQuotes.length;
                  return (
                    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm flex flex-col">
                      <div className="px-4 py-3 flex items-center justify-between border-b border-slate-200 bg-slate-50/50">
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                            checked={allSelected}
                            onChange={() => toggleAllInFolder(allOrgQuotes.map(q => q.quote_id))}
                          />
                          <p className="text-xs font-semibold text-slate-500">
                            {selectedOrgCount} of {allOrgQuotes.length} plan(s) selected
                          </p>
                        </div>
                        <button
                          onClick={() => handleBulkProceed(allOrgQuotes)}
                          disabled={isBulkProceeding || selectedOrgCount === 0}
                          className="flex items-center gap-2 px-3.5 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 disabled:opacity-50 disabled:bg-slate-400 transition-colors shadow-sm"
                        >
                          {isBulkProceeding ? "Processing..." : "Batch Proceed to Underwriting"}
                        </button>
                      </div>
                      {viewMode === 'grid' ? (
                        <div className="p-4 bg-slate-50/30">
                          <ProposalsGrid
                            quotes={allOrgQuotes}
                            selectedQuoteIds={selectedQuoteIds}
                            toggleSelection={toggleSelection}
                            toggleAllInFolder={toggleAllInFolder}
                            openQuote={openQuote}
                          />
                        </div>
                      ) : (
                        <ProposalsTable
                          quotes={allOrgQuotes}
                          selectedQuoteIds={selectedQuoteIds}
                          toggleSelection={toggleSelection}
                          toggleAllInFolder={toggleAllInFolder}
                          openQuote={openQuote}
                        />
                      )}
                    </div>
                  );
                })()}"""
text = re.sub(org_search, org_replace, text)

# Replace familyGroups rendering
fam_search = r'\{familyGroups\.map\(\(family\) => \([\s\S]*?viewMode=\{viewMode\}\s*\/>\s*\)\)\}'
fam_replace = """{(() => {
                  const allFamQuotes = familyGroups.flatMap(family => family.policies.flatMap(p => p.customers.flatMap(c => c.quotes)));
                  const selectedFamCount = allFamQuotes.filter(q => selectedQuoteIds.has(q.quote_id)).length;
                  const allSelected = allFamQuotes.length > 0 && selectedFamCount === allFamQuotes.length;
                  return (
                    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm flex flex-col">
                      <div className="px-4 py-3 flex items-center justify-between border-b border-slate-200 bg-slate-50/50">
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                            checked={allSelected}
                            onChange={() => toggleAllInFolder(allFamQuotes.map(q => q.quote_id))}
                          />
                          <p className="text-xs font-semibold text-slate-500">
                            {selectedFamCount} of {allFamQuotes.length} plan(s) selected
                          </p>
                        </div>
                        <button
                          onClick={() => handleBulkProceed(allFamQuotes)}
                          disabled={isBulkProceeding || selectedFamCount === 0}
                          className="flex items-center gap-2 px-3.5 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 disabled:opacity-50 disabled:bg-slate-400 transition-colors shadow-sm"
                        >
                          {isBulkProceeding ? "Processing..." : "Batch Proceed to Underwriting"}
                        </button>
                      </div>
                      {viewMode === 'grid' ? (
                        <div className="p-4 bg-slate-50/30">
                          <ProposalsGrid
                            quotes={allFamQuotes}
                            selectedQuoteIds={selectedQuoteIds}
                            toggleSelection={toggleSelection}
                            toggleAllInFolder={toggleAllInFolder}
                            openQuote={openQuote}
                          />
                        </div>
                      ) : (
                        <ProposalsTable
                          quotes={allFamQuotes}
                          selectedQuoteIds={selectedQuoteIds}
                          toggleSelection={toggleSelection}
                          toggleAllInFolder={toggleAllInFolder}
                          openQuote={openQuote}
                        />
                      )}
                    </div>
                  );
                })()}"""
text = re.sub(fam_search, fam_replace, text)

# Delete unused folder components to clean up the file
# Start from "// ── Shared props" up to "// ── Level 3: Proposals Views"
start_idx = text.find("// ── Shared props for the two lower folder levels")
end_idx = text.find("// ── Level 3: Proposals Views")
if start_idx != -1 and end_idx != -1:
    text = text[:start_idx] + text[end_idx:]

with open("frontend/app/proposal/page.tsx", "w") as f:
    f.write(text)
