import asyncio
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import HumanMessage

async def main():
    llm = ChatGoogleGenerativeAI(model='gemini-2.5-flash')
    msg = HumanMessage(content=[
        {'type': 'text', 'text': 'What is this?'},
        {'type': 'image_url', 'image_url': {'url': 'data:application/pdf;base64,JVBERi0xLgoxIDAgb2JqPDwvUGFnZXMgMiAwIFI+PmVuZG9iagoyIDAgb2JqPDwvS2lkc1tdL0NvdW50IDA+PmVuZG9iagp0cmFpbGVyPDwvUm9vdCAxIDAgUj4+CiUlRU9G'}}
    ])
    res = await llm.ainvoke([msg])
    print(res.content)

asyncio.run(main())
