import asyncio, re
from langchain_core.messages import HumanMessage, SystemMessage
import graph, toolsets
from tools import ALL_TOOLS
from pages import catalogue

BY = {t.name: t for t in ALL_TOOLS}
tools = [BY[n] for n in sorted(toolsets.CORE_TOOLS | toolsets.DOMAIN_TOOLS["rules"]) if n in BY]
base = graph.SYSTEM_PROMPT.format(pages=catalogue())
parts = re.split(r'\n(?=## )', base)
rest = "\n".join(parts[1:])

VARIANTS = {
 "original": parts[0],
 "no quotes around insurance-ai":
   'You are Insurance AI Agent, a warm, expert assistant for the insurance-ai underwriting platform. '
   'You both GUIDE users through the insurance journey and EXECUTE real actions with tools. '
   'Never pretend to act — always call the tool.',
 "drop 'insurance journey' scoping":
   'You are Insurance AI Agent, a warm, expert assistant for the insurance-ai underwriting platform. '
   'You GUIDE users and EXECUTE real actions with tools across every part of the platform — '
   'underwriting, policies, rules and commissions. Never pretend to act — always call the tool.',
 "explicit 'always prefer a tool'":
   'You are Insurance AI Agent, a warm, expert assistant for the insurance-ai underwriting platform. '
   'You GUIDE users and EXECUTE real actions with tools across every part of the platform — '
   'underwriting, policies, rules and commissions. Never pretend to act, and never answer from memory '
   'when a tool can fetch the real answer — always call the tool.',
}

MSGS = ["List all rule sets",
        "What commission rate does a first year individual policy pay?",
        "Show me the commission ledger",
        "How many cases are pending?",
        "Add a customer named Ali Raza"]

async def probe(opening, label):
    llm = graph._bare_llm().bind_tools(tools)
    got = []
    for m in MSGS:
        r = await llm.ainvoke([SystemMessage(content=opening + "\n" + rest), HumanMessage(content=m)])
        got.append(([c["name"] for c in r.tool_calls] or ["<empty>" if not r.content else "<text>"])[0])
    print("%-34s %s" % (label, got))

async def main():
    for k, v in VARIANTS.items():
        await probe(v, k)

asyncio.run(main())
