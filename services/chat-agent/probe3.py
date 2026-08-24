import asyncio, re
from langchain_core.messages import HumanMessage, SystemMessage
import graph, toolsets
from tools import ALL_TOOLS
from pages import catalogue

BY = {t.name: t for t in ALL_TOOLS}
tools = [BY[n] for n in sorted(toolsets.CORE_TOOLS | toolsets.DOMAIN_TOOLS["rules"]) if n in BY]
base = graph.SYSTEM_PROMPT.format(pages=catalogue())

# Split on "## " headings
parts = re.split(r'\n(?=## )', base)
print("sections:", [p.split("\n")[0][:50] for p in parts])
print()

async def probe(sysprompt, label, msg="List all rule sets"):
    llm = graph._bare_llm().bind_tools(tools)
    r = await llm.ainvoke([SystemMessage(content=sysprompt), HumanMessage(content=msg)])
    print("%-52s calls=%s" % (label, [c["name"] for c in r.tool_calls]))

async def main():
    # leave-one-out
    for i in range(len(parts)):
        trimmed = "\n".join(p for j, p in enumerate(parts) if j != i)
        await probe(trimmed, "WITHOUT: " + parts[i].split("\n")[0][:40])

asyncio.run(main())
