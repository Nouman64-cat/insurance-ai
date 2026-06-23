from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import _session_factory
from migrate import run_migrations
from routers.tenants import router as tenants_router
from routers.users import router as users_router
from routers.auth import router as auth_router
from routers.applicants import router as applicants_router
from shared.models.core import Role

# ── Standard RBAC roles seeded once at startup ────────────────────────────────

_SEED_ROLES = [
    ("Admin",       "Full platform access — manage tenants, users, and all resources."),
    ("Underwriter", "Evaluate proposals, review risk assessments, and make decisions."),
    ("Agent",       "Submit proposals and track their status."),
    ("Viewer",      "Read-only access to dashboards and reports."),
]


async def _seed_roles(session: AsyncSession) -> None:
    for name, description in _SEED_ROLES:
        exists = (await session.exec(select(Role).where(Role.name == name))).first()
        if not exists:
            session.add(Role(name=name, description=description))
    await session.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await run_migrations()
    async with _session_factory() as session:
        await _seed_roles(session)
    yield


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="insurance-ai — Tenant Service",
    version="0.1.0",
    description="Manages insurance companies (tenants) and their employees (users). "
                "Every downstream microservice uses the tenant_id issued here.",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tenants_router)
app.include_router(users_router)
app.include_router(auth_router)
app.include_router(applicants_router)


@app.get("/health", tags=["Ops"])
async def health_check():
    return {"service": "tenant-service", "status": "healthy"}


@app.get("/roles", tags=["Roles"])
async def list_roles():
    from database import get_session
    async for session in get_session():
        roles = list(await session.exec(select(Role)))
        return [{"id": str(r.id), "name": r.name, "description": r.description} for r in roles]
