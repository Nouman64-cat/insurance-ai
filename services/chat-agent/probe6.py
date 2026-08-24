import asyncio
from langchain_core.messages import HumanMessage, SystemMessage
import graph, toolsets
from tools import ALL_TOOLS
BY = {t.name: t for t in ALL_TOOLS}
SYS = graph._build_prompt("Admin")

MSGS = ["What underwriting rule sets do we have?",
        "What commission rate does a first year individual policy pay?"]

async def run(msg, doms):
    names = toolsets.tool_names_for(doms)
    llm = graph._bare_llm().bind_tools([BY[n] for n in sorted(names) if n in BY])
    r = await llm.ainvoke([SystemMessage(content=SYS), HumanMessage(content=msg)])
    return ([c["name"] for c in r.tool_calls] or ["<empty>" if not r.content else "<text>"])[0], len(names)

async def main():
    for m in MSGS:
        auto = sorted(toolsets.select_domains([m]))
        print("\n" + m)
        print("   select_domains ->", auto)
        for doms in ([], auto, ["rules"], ["commission"], list(toolsets.DOMAIN_TOOLS)):
            out, n = await run(m, doms)
            print("   %-42s (%2d tools) -> %s" % (str(doms)[:40], n, out))
asyncio.run(main())
