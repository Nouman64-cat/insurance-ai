import asyncio
from langchain_core.messages import HumanMessage, SystemMessage
import graph, toolsets

MSGS = ["Open the rule engine page", "What underwriting rule sets do we have?"]

async def main():
    for m in MSGS:
        doms = frozenset(toolsets.select_domains([m]))
        llm = graph._llm("Admin", "web", doms)
        sys_p = graph._build_prompt("Admin", "web", doms)
        r = await llm.ainvoke([SystemMessage(content=sys_p), HumanMessage(content=m)])
        print("---", m)
        print("   domains:", sorted(doms), "| sys chars:", len(sys_p))
        print("   content:", repr(r.content)[:120])
        print("   tool_calls:", r.tool_calls)
        print("   finish:", r.response_metadata.get("finish_reason"))
        print("   safety:", r.response_metadata.get("safety_ratings"))
        print("   usage:", r.usage_metadata)
asyncio.run(main())
