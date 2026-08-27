from langgraph.graph import StateGraph, START, END
from langgraph.types import interrupt, Command
from typing import TypedDict
import asyncio

class State(TypedDict):
    val: str

async def node_a(state: State):
    print("Executing node_a")
    print("Calling first interrupt")
    res1 = interrupt("interrupt 1")
    print(f"First interrupt returned: {res1}")
    
    print("Calling second interrupt")
    res2 = interrupt("interrupt 2")
    print(f"Second interrupt returned: {res2}")
    
    return {"val": "done"}

async def main():
    builder = StateGraph(State)
    builder.add_node("node_a", node_a)
    builder.add_edge(START, "node_a")
    builder.add_edge("node_a", END)
    
    from langgraph.checkpoint.memory import MemorySaver
    memory = MemorySaver()
    graph = builder.compile(checkpointer=memory)
    
    config = {"configurable": {"thread_id": "1"}}
    
    print("--- FIRST RUN ---")
    async for chunk in graph.astream({"val": "start"}, config):
        print(chunk)
        
    print("\n--- RESUMING FIRST INTERRUPT ---")
    async for chunk in graph.astream(Command(resume="resume_value_1"), config):
        print(chunk)
        
    print("\n--- RESUMING SECOND INTERRUPT ---")
    async for chunk in graph.astream(Command(resume="resume_value_2"), config):
        print(chunk)

if __name__ == "__main__":
    asyncio.run(main())
