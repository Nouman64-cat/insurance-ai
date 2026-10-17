import asyncio
from langchain_core.messages import HumanMessage, SystemMessage
import graph, toolsets
from tools import ALL_TOOLS
BY = {t.name: t for t in ALL_TOOLS}
tools = [BY[n] for n in sorted(toolsets.tool_names_for(["rules"])) if n in BY]

async def probe(sys_p, label, msg="What underwriting rule sets do we have?"):
    llm = graph._bare_llm().bind_tools(tools)
    r = await llm.ainvoke([SystemMessage(content=sys_p), HumanMessage(content=msg)])
    print("%-38s -> %s" % (label, [c["name"] for c in r.tool_calls] or ("<text>" if r.content else "<EMPTY>")))

async def main():
    base = graph._SYSTEM_PROMPT_CACHED
    rules = graph.DOMAIN_PROMPTS["rules"]
    comm  = graph.DOMAIN_PROMPTS["commission"]
    await probe(base, "base only")
    await probe(base + rules, "base + rules section")
    await probe(base + comm, "base + commission section")
    await probe(base + rules + comm, "base + both")
    # strip the maker-checker numbered list from the rules section
    head = rules.split("Editing follows")[0]
    await probe(base + head, "base + rules (read half only)")
asyncio.run(main())
