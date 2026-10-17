import asyncio
from langchain_core.messages import HumanMessage, SystemMessage
import graph, toolsets
from tools import ALL_TOOLS
from pages import catalogue

BY = {t.name: t for t in ALL_TOOLS}
names = sorted(toolsets.CORE_TOOLS | toolsets.DOMAIN_TOOLS["rules"])
tools = [BY[n] for n in names if n in BY]

async def probe(sysprompt, label, msg="List all rule sets"):
    llm = graph._bare_llm().bind_tools(tools)
    r = await llm.ainvoke([SystemMessage(content=sysprompt), HumanMessage(content=msg)])
    print("%-40s content=%-5s calls=%s" % (label, bool(r.content), [c["name"] for c in r.tool_calls]))

async def main():
    base = graph.SYSTEM_PROMPT.format(pages=catalogue())
    await probe("You are a helpful assistant.", "tiny prompt")
    await probe(base, "SYSTEM_PROMPT only (no rules section)")
    await probe(base + graph.RULES_ENGINE_PROMPT, "SYSTEM_PROMPT + RULES_ENGINE_PROMPT")
    await probe(graph.RULES_ENGINE_PROMPT, "RULES_ENGINE_PROMPT only")

asyncio.run(main())
