"""Test harness: a disposable PostgreSQL database with the real migrations and the real least-privilege roles, and an
in-memory tenant-service that honours the same contract (identity, scoped lookups, signed directory, idempotent and
conflict-checking corrections).

Run inside the service container (it has the Postgres credentials from .env):
    docker compose exec -T request-management-service python -m unittest discover -s tests -v
"""
import asyncio
import os
import uuid
from copy import deepcopy
from typing import Optional
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app import db, identity, migrate, provision, tenant_client
from app.tenant_client import DomainResponse
from shared.requests.customer_corrections import FIELDS, current_value

ADMIN_USER = os.environ.get("POSTGRES_USER", "postgres")
ADMIN_PASSWORD = os.environ.get("POSTGRES_PASSWORD", "")
HOST = os.environ.get("TEST_DB_HOST", "host.docker.internal:5432")
OWNER_PW = os.environ["REQUEST_MGMT_DB_OWNER_PASSWORD"]
APP_PW = os.environ["REQUEST_MGMT_DB_APP_PASSWORD"]
TEST_DB = f"rm_test_{uuid.uuid4().hex[:10]}"


def url(user: str, password: str, database: str) -> str:
    return f"postgresql+asyncpg://{user}:{password}@{HOST}/{database}"


async def create_database() -> None:
    admin = create_async_engine(url(ADMIN_USER, ADMIN_PASSWORD, "postgres"), isolation_level="AUTOCOMMIT")
    async with admin.connect() as conn:
        await conn.execute(text(f'CREATE DATABASE "{TEST_DB}"'))
    await admin.dispose()
    await provision.provision(url(ADMIN_USER, ADMIN_PASSWORD, TEST_DB), "request_management",
                              "request_mgmt_owner", OWNER_PW, "request_mgmt_app", APP_PW)
    await migrate.run(url("request_mgmt_owner", OWNER_PW, TEST_DB), "request_management")
    db.configure(url("request_mgmt_app", APP_PW, TEST_DB))


async def drop_database() -> None:
    await db.dispose()
    admin = create_async_engine(url(ADMIN_USER, ADMIN_PASSWORD, "postgres"), isolation_level="AUTOCOMMIT")
    async with admin.connect() as conn:
        await conn.execute(text(f'DROP DATABASE IF EXISTS "{TEST_DB}" WITH (FORCE)'))
    await admin.dispose()


class FakeTenantService:
    """users: token -> /auth/me payload. Customers and earnings are visible to a token only if listed in `access`."""

    def __init__(self):
        self.me_by_token: dict[str, dict] = {}
        self.me_status: dict[str, int] = {}
        self.customers: dict[UUID, dict] = {}
        self.earnings: dict[UUID, dict] = {}
        self.access: dict[str, set[UUID]] = {}
        self.corrections: dict[str, dict] = {}
        self.correction_calls: list[dict] = []
        self.fail_next: list[int] = []

    # identity
    def add_user(self, tenant_id: UUID, role: str, name: Optional[str] = None, branch_id: Optional[UUID] = None, active: bool = True) -> str:
        token = f"token-{uuid.uuid4().hex}"
        uid = uuid.uuid4()
        self.me_by_token[token] = {"id": str(uid), "tenant_id": str(tenant_id), "full_name": name or f"{role} {str(uid)[:4]}",
                                   "email": f"{str(uid)[:8]}@example.test", "role_name": role, "branch_id": str(branch_id) if branch_id else None,
                                   "is_active": active, "status": "ACTIVE" if active else "INACTIVE"}
        self.access[token] = set()
        return token

    def uid(self, token: str) -> UUID:
        return UUID(self.me_by_token[token]["id"])

    async def me(self, token: str) -> DomainResponse:
        if token in self.me_status:
            return DomainResponse(self.me_status[token], {"detail": "nope"})
        me = self.me_by_token.get(token)
        return DomainResponse(200, deepcopy(me)) if me else DomainResponse(401, {"detail": "Could not validate credentials"})

    async def users(self, tenant_id: UUID, ids=None, roles=None) -> list[dict]:
        out = []
        for me in self.me_by_token.values():
            if me["tenant_id"] != str(tenant_id):
                continue
            if ids and UUID(me["id"]) not in set(ids):
                continue
            if roles and me["role_name"] not in roles:
                continue
            out.append({"id": me["id"], "tenant_id": me["tenant_id"], "full_name": me["full_name"], "email": me["email"],
                        "role_name": me["role_name"], "branch_id": me["branch_id"], "is_active": me["is_active"] and me["status"] == "ACTIVE"})
        return out

    # domain records
    def add_customer(self, tenant_id: UUID, visible_to: list[str], **fields) -> UUID:
        cid = uuid.uuid4()
        self.customers[cid] = {"id": str(cid), "tenant_id": str(tenant_id), "name": fields.pop("name", "Sara Ahmed"),
                               "branch_id": None, "city": "Lahore", "province": "Punjab", "marital_status": "Single",
                               "details": {"contact": {"mobile_number": "0300 1234567", "email": "old@example.test"}}, **fields}
        for token in visible_to:
            self.access[token].add(cid)
        return cid

    def add_earning(self, tenant_id: UUID, visible_to: list[str]) -> UUID:
        eid = uuid.uuid4()
        self.earnings[eid] = {"id": str(eid), "tenant_id": str(tenant_id), "policy_id": str(uuid.uuid4()), "gross_amount": "1500.00",
                              "rate_pct": "10.0000", "basis_amount": "15000.00", "split_pct": "100.0000", "policy_year": 1}
        for token in visible_to:
            self.access[token].add(eid)
        return eid

    async def get_customer(self, token, tenant_id, customer_id):
        c = self.customers.get(customer_id)
        if not c or c["tenant_id"] != str(tenant_id) or customer_id not in self.access.get(token, set()):
            return None
        return deepcopy(c)

    async def get_earning(self, token, tenant_id, earning_id):
        e = self.earnings.get(earning_id)
        if not e or e["tenant_id"] != str(tenant_id) or earning_id not in self.access.get(token, set()):
            return None
        return deepcopy(e)

    async def apply_profile_correction(self, tenant_id, customer_id, body) -> DomainResponse:
        self.correction_calls.append(deepcopy(body))
        if self.fail_next:
            return DomainResponse(self.fail_next.pop(0), {"detail": {"code": "UNAVAILABLE", "message": "down"}})
        key = body["execution_key"]
        if key in self.corrections:
            return DomainResponse(200, {"status": "ALREADY_APPLIED", **self.corrections[key]})
        customer = self.customers[customer_id]
        conflicts = [k for k, ch in body["changes"].items() if current_value(customer, k) != ch["before"]]
        if conflicts:
            return DomainResponse(409, {"detail": {"code": "CONFLICT", "message": "changed", "fields": conflicts}})
        for k, ch in body["changes"].items():
            f = FIELDS[k]
            if f.column:
                customer[f.column] = ch["after"]
            else:
                customer.setdefault("details", {}).setdefault(f.details_path[0], {})[f.details_path[1]] = ch["after"]
        self.corrections[key] = {"correction_id": str(uuid.uuid4())}
        return DomainResponse(200, {"status": "APPLIED", **self.corrections[key]})


def install(fake: FakeTenantService) -> None:
    tenant_client.set_client(fake)
    identity.clear_cache()


async def who(fake: FakeTenantService, token: str):
    identity.clear_cache()
    return await identity.resolve(token)


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)
