with open("frontend/lib/agent/useAgentChat.ts", "r") as f:
    content = f.read()

target = "const clearChat = useCallback(() => {"
replacement = """  const loadChat = useCallback((loadedMessages: AgentMessage[], loadedActions: QuickAction[]) => {
    setMessages(loadedMessages);
    setTurnActions(loadedActions);
    setPendingInterrupt(null);
    setSteps([]);
  }, []);

  const clearChat = useCallback(() => {"""

if target in content:
    with open("frontend/lib/agent/useAgentChat.ts", "w") as f:
        f.write(content.replace(target, replacement))
    
    target2 = "return { messages, send, resolveInterrupt, isLoading, pendingInterrupt, clearChat, steps, turnActions };"
    replacement2 = "return { messages, send, resolveInterrupt, isLoading, pendingInterrupt, clearChat, loadChat, steps, turnActions };"
    with open("frontend/lib/agent/useAgentChat.ts", "r") as f:
        content2 = f.read()
    with open("frontend/lib/agent/useAgentChat.ts", "w") as f:
        f.write(content2.replace(target2, replacement2))
    print("PATCHED")
else:
    print("NOT FOUND")
