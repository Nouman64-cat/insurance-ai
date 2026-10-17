import asyncio
from langchain_core.messages import HumanMessage, SystemMessage
import graph, toolsets
from tools import ALL_TOOLS

BY = {t.name: t for t in ALL_TOOLS}
core = sorted(toolsets.CORE_TOOLS)
extra = [n for n in sorted(BY) if n not in toolsets.CORE_TOOLS]
SYS = graph._SYSTEM_PROMPT_CACHED  # base only, no domain sections

async def probe(names, msg):
    llm = graph._bare_llm().bind_tools([BY[n] for n in names])
    r = await llm.ainvoke([SystemMessage(content=SYS), HumanMessage(content=msg)])
    ok = bool(r.content or r.tool_calls)
    return ok, r.usage_metadata.get("input_tokens", 0)

async def main():
    msg = "How many cases are pending?"
    print("tool_count  input_tokens  responded")
    for k in [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 71]:
        names = (core + extra)[:k]
        ok, tok = await probe(names, msg)
        print(f"{k:>10}  {tok:>12}  {'YES' if ok else 'EMPTY'}")
asyncio.run(main())
