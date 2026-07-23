import re

with open("frontend/app/admin/leads/page.tsx", "r") as f:
    code = f.read()

# Remove ViewMode type
code = code.replace('type ViewMode = "board" | "card" | "table";\n', '')

# Remove view state
code = code.replace('const [view, setView] = useState<ViewMode>("board");\n', '')

# Remove VIEW_STORAGE_KEY
code = code.replace('const VIEW_STORAGE_KEY = "leads_view_mode";\n', '')

# Remove view from dependency array
code = code.replace('  useEffect(() => {\n    setPage(1);\n  }, [search, filterType, view, dateFrom, dateTo, cityFilter, provinceFilter, branchFilter, agentFilter]);\n', '  useEffect(() => {\n    setPage(1);\n  }, [search, filterType, dateFrom, dateTo, cityFilter, provinceFilter, branchFilter, agentFilter]);\n')

# Remove useEffect for VIEW_STORAGE_KEY
storage_eff = """  useEffect(() => {
    const saved = localStorage.getItem(VIEW_STORAGE_KEY);
    if (saved === "board" || saved === "card" || saved === "table") setView(saved);
  }, []);

  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  }, [view]);"""
code = code.replace(storage_eff, '')

# Remove View Switch UI
view_switch = """              {/* View switch */}
              <div className="inline-flex bg-slate-100/80 p-1 rounded-xl shadow-inner backdrop-blur-md border border-slate-200/60">
                {(["board", "card", "table"] as ViewMode[]).map((v) => (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-300 ${
                      view === v
                        ? "bg-white text-indigo-600 shadow-md ring-1 ring-black/5 scale-[1.02]"
                        : "text-slate-500 hover:text-slate-700 hover:bg-slate-200/50"
                    }`}
                  >
                    {v === "board" ? "Board" : v === "card" ? "Cards" : "Table"}
                  </button>
                ))}
              </div>"""
code = code.replace(view_switch, '')

# Remove `{view === "board" && (`
code = code.replace('{view === "board" && (\n', '')

# Remove `)}` after board view, and all the card/table views.
# Wait, let's just find where it ends.
card_table_start = """        {/* Card view — flattened, searchable, paginated */}"""
import sys
index = code.find(card_table_start)
if index != -1:
    end_index = code.find("      {selectedEntity && (", index)
    if end_index != -1:
        # Before card_table_start there is a `)}` that we should also remove.
        # Let's find the `)}` right before card_table_start.
        pre_index = code.rfind(')}', 0, index)
        if pre_index != -1:
            code = code[:pre_index] + code[pre_index+2:index] + code[end_index:]

with open("frontend/app/admin/leads/page.tsx", "w") as f:
    f.write(code)

print("success")
