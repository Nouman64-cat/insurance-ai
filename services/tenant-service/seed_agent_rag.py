import asyncio
import os
import glob
from google import genai
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import text
from shared.models.core import AgentKnowledgeBase

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql+asyncpg://postgres:1122@host.docker.internal:5432/insurance_ai",
)

engine = create_async_engine(DATABASE_URL, echo=False, future=True)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

async def seed():
    docs_dir = "/app/docs/agent-scenarios/*.md" # since it runs inside container mapped to root... wait, tenant-service is mapped to /app. The docs are at ../../docs. 
    # Let's just use a relative path if running from insurance-ai
    
    # We will pass the path as an argument or just hardcode for running inside container
    files = glob.glob("/app/agent-scenarios/*.md")
    if not files:
        # Fallback for docker compose exec which runs in /app (mapped to tenant-service)
        files = glob.glob("/app/agent-scenarios/*.md")
        
    async with AsyncSessionLocal() as session:
        # Clear existing
        await session.execute(text("TRUNCATE TABLE agent_knowledge_base;"))
        
        for file in files:
            with open(file, "r") as f:
                content = f.read()
                
            title = os.path.basename(file).replace(".md", "").replace("_", " ").title()
            
            # Get embedding
            response = client.models.embed_content(
                model="models/gemini-embedding-001",
                contents=content,
            )
            embedding = response.embeddings[0].values
            
            kb = AgentKnowledgeBase(
                category="SOP",
                title=title,
                content=content,
                embedding=embedding
            )
            session.add(kb)
            print(f"Seeded {title}")
            
        await session.commit()

if __name__ == "__main__":
    asyncio.run(seed())
