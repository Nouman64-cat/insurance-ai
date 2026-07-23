import re

with open("frontend/app/proposal/page.tsx", "r") as f:
    code = f.read()

# Need to update QuoteDetailModal to include dropdowns to update status and assigned_underwriter_id

# Update QuoteDetailModal signature
sig_update = """function QuoteDetailModal({
  detail, loading, error, onClose, onStartUnderwriting,
}: {
  detail: QuoteDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onStartUnderwriting: () => Promise<void>;
}) {"""
sig_new = """function QuoteDetailModal({
  detail, loading, error, onClose, onStartUnderwriting, onRefresh
}: {
  detail: QuoteDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onStartUnderwriting: () => Promise<void>;
  onRefresh: () => void;
}) {
  const [underwriters, setUnderwriters] = useState<Agent[]>([]);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    const tenantId = localStorage.getItem("tenant_id");
    if (tenantId) listUnderwriters(tenantId).then(setUnderwriters).catch(console.error);
  }, []);

  const handleUpdate = async (updates: { status?: string; assigned_underwriter_id?: string | null }) => {
    if (!detail) return;
    setUpdating(true);
    try {
      await updateQuote(detail.quote_id, updates);
      onRefresh();
      onClose(); // Alternatively just refresh details, but close is simpler.
    } catch (err: any) {
      alert(err.message || "Update failed");
    } finally {
      setUpdating(false);
    }
  };
"""

code = code.replace(sig_update, sig_new)

# In the render, add status/underwriter selectors
selectors = """
            {/* Status and Underwriter Update */}
            <div className="grid grid-cols-2 gap-4 bg-slate-50 border border-slate-200 p-4 rounded-xl">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 block mb-1">Status</label>
                <select 
                  className="w-full text-sm border border-slate-200 rounded-lg p-2 bg-white"
                  value={detail.status}
                  onChange={e => handleUpdate({ status: e.target.value })}
                  disabled={updating}
                >
                  {STATUS_TABS.slice(1).map(tab => (
                    <option key={tab.id} value={tab.id}>{tab.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 block mb-1">Assigned Underwriter</label>
                <select 
                  className="w-full text-sm border border-slate-200 rounded-lg p-2 bg-white"
                  value={detail.assigned_underwriter_id || ""}
                  onChange={e => handleUpdate({ assigned_underwriter_id: e.target.value || null })}
                  disabled={updating}
                >
                  <option value="">Unassigned</option>
                  {underwriters.map(u => (
                    <option key={u.id} value={u.id}>{u.full_name}</option>
                  ))}
                </select>
              </div>
            </div>
"""
code = code.replace('{/* Headline */}', selectors + '\n            {/* Headline */}')

# Pass onRefresh to QuoteDetailModal from QuotePage
code = code.replace('onStartUnderwriting={async () => {', 'onRefresh={fetchQuotes}\n          onStartUnderwriting={async () => {')

with open("frontend/app/proposal/page.tsx", "w") as f:
    f.write(code)

print("success")
