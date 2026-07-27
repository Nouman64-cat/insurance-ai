import re

with open("frontend/components/CopilotInterface.tsx", "r") as f:
    content = f.read()

injection = """  // Force disable global dark mode while in automation mode so the chat retains its designed theme
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isAutomationMode) {
      const wasDark = document.documentElement.classList.contains("dark");
      if (wasDark) {
        document.documentElement.classList.remove("dark");
        return () => {
          document.documentElement.classList.add("dark");
        };
      }
    }
  }, [isAutomationMode]);

  if (isAutomationMode) {"""

content = content.replace("  if (isAutomationMode) {", injection)

with open("frontend/components/CopilotInterface.tsx", "w") as f:
    f.write(content)

print("SUCCESS")
