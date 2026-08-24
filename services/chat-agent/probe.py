import asyncio
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import tool
from pydantic import BaseModel, Field
from typing import Optional
import graph

SYS = [SystemMessage(content="You are a helpful assistant. Use tools when asked.")]

async def probe(t, label, msg="List all rule sets"):
    llm = graph._bare_llm().bind_tools([t])
    r = await llm.ainvoke(SYS + [HumanMessage(content=msg)])
    names = [c["name"] for c in r.tool_calls]
    print("%-34s content=%-5s calls=%s" % (label, bool(r.content), names))

class A(BaseModel):
    category: Optional[str] = Field(default=None, description="Category code filter, e.g. MEDICAL_NML.")
    channel: Optional[str] = Field(default=None, description="Channel code filter, e.g. AGENCY_DIRECT.")

@tool(args_schema=A)
def list_rule_sets(**kwargs) -> str:
    """List underwriting rule sets with their active version and rule count.
    Use for "what rules do we have?", "show the NML rules", "list rule sets"."""
    return "{}"

@tool(args_schema=A)
def list_rule_sets_short(**kwargs) -> str:
    """List underwriting rule sets."""
    return "{}"

@tool(args_schema=A)
def show_rulebooks(**kwargs) -> str:
    """List underwriting rule sets with their active version and rule count.
    Use for "what rules do we have?", "show the NML rules", "list rule sets"."""
    return "{}"

async def main():
    await probe(list_rule_sets, "original name+desc")
    await probe(list_rule_sets_short, "same name, short desc")
    await probe(show_rulebooks, "diff name, same desc")

asyncio.run(main())
