import asyncio
from langchain_core.messages import HumanMessage, SystemMessage
import graph, toolsets
from tools import ALL_TOOLS

BY = {t.name: t for t in ALL_TOOLS}
tools = [BY[n] for n in sorted(toolsets.CORE_TOOLS | toolsets.DOMAIN_TOOLS["rules"]) if n in BY]
SYS = graph._build_prompt("Admin")

MSGS = ["List all rule sets",
        "What underwriting rule sets do we have?",
        "Show me the rule sets in the rule engine",
        "list_rule_sets",
        "Open the rule engine and list the rule sets"]

async def main():
    llm = graph._bare_llm().bind_tools(tools)
    for m in MSGS:
        outs = []
        for _ in range(3):
            r = await llm.ainvoke([SystemMessage(content=SYS), HumanMessage(content=m)])
            outs.append(([c["name"] for c in r.tool_calls] or ["<empty>" if not r.content else "<text>"])[0])
        print("%-46s %s" % (m[:44], outs))

asyncio.run(main())
