import re

with open("frontend/components/CopilotInterface.tsx", "r") as f:
    content = f.read()

# 1. Update useAgentChat destructuring
content = content.replace(
    "const { messages, send, resolveInterrupt, isLoading, pendingInterrupt, clearChat, steps, turnActions } = useAgentChat",
    "const { messages, send, resolveInterrupt, isLoading, pendingInterrupt, clearChat, loadChat, steps, turnActions } = useAgentChat"
)

# 2. Add sessions state and activeSessionId
state_insertion = """  const [sessions, setSessions] = useState<{id: string, date: number, title: string, messages: any[], actions: any[]}[]>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem(STORAGE_KEY + "_sessions");
        if (saved) return JSON.parse(saved);
      } catch {}
    }
    return [];
  });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY + "_sessions", JSON.stringify(sessions));
    }
  }, [sessions]);

  const saveCurrentSession = () => {
    if (messages.length <= 1) return;
    const title = messages.find(m => m.role === 'user')?.text || "New Conversation";
    const sessionId = activeSessionId || Date.now().toString();
    setSessions(prev => {
      const filtered = prev.filter(s => s.id !== sessionId);
      return [{
        id: sessionId,
        date: Date.now(),
        title: title.length > 35 ? title.slice(0, 35) + "..." : title,
        messages: [...messages],
        actions: [...turnActions]
      }, ...filtered];
    });
  };

  const handleClearChat = () => {
    saveCurrentSession();
    setActiveSessionId(null);
    clearChat();
    setSuggestedActions([]);
    localStorage.removeItem(STORAGE_KEY + "_suggestions");
  };

  const handleLoadSession = (session: any) => {
    saveCurrentSession();
    setActiveSessionId(session.id);
    loadChat(session.messages, session.actions || []);
  };

  const handleDeleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessions(prev => prev.filter(s => s.id !== id));
    if (activeSessionId === id) {
      handleClearChat();
    }
  };
"""

content = re.sub(
    r'  const handleClearChat = \(\) => \{\n    clearChat\(\);\n    setSuggestedActions\(\[\]\);\n    localStorage\.removeItem\(STORAGE_KEY \+ "_suggestions"\);\n  \};',
    state_insertion,
    content
)

# 3. Inject into the Sidebar
sidebar_insertion = """          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
            {sessions.length > 0 && (
              <div className="space-y-1">
                {sessions.map(session => (
                  <button
                    key={session.id}
                    onClick={() => handleLoadSession(session)}
                    className={`w-full text-left px-3 py-2.5 rounded-xl transition-colors group flex items-center justify-between ${activeSessionId === session.id ? 'bg-white/10' : 'hover:bg-white/5'}`}
                  >
                    <div className="flex-1 min-w-0 pr-2">
                      <div className="text-[13px] font-medium text-slate-300 truncate group-hover:text-white transition-colors">
                        {session.title}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {new Date(session.date).toLocaleDateString()}
                      </div>
                    </div>
                    <button onClick={(e) => handleDeleteSession(session.id, e)} className="text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all p-1">
                       <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                  </button>
                ))}
              </div>
            )}
          </div>"""

content = content.replace(
    '          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">\n          </div>',
    sidebar_insertion
)

with open("frontend/components/CopilotInterface.tsx", "w") as f:
    f.write(content)

print("SUCCESS")
