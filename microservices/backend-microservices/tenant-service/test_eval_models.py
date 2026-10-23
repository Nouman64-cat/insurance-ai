"""The model registry API against the running tenant-service, with real tokens (a Super Admin and an ordinary user):
who may use it, what it refuses, that prices are append-only and the provider/model of an entry cannot change.
Creates its own test entries and removes them afterwards.

Run: docker compose exec -T tenant-service python test_eval_models.py
"""
import asyncio
import sys
import uuid
from datetime import datetime, timedelta

import httpx
from sqlalchemy import delete
from sqlmodel import select

import database
from routers.auth import create_access_token
from shared.models.core import Role, User
from shared.models.evaluation import EvalModel, EvalModelPrice

BASE = "http://localhost:8001"
FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


async def tokens() -> tuple[str, str]:
    async with database._session_factory() as s:
        sa_role = (await s.exec(select(Role).where(Role.name == "SuperAdmin"))).first()
        admin = (await s.exec(select(User).where(User.role_id == sa_role.id, User.is_deleted == False))).first()  # noqa: E712
        other = (await s.exec(select(User).where(User.role_id != sa_role.id, User.is_deleted == False))).first()    # noqa: E712
        return create_access_token({"sub": str(admin.id)}), create_access_token({"sub": str(other.id)})


async def main() -> int:
    admin, other = await tokens()
    A, O = {"Authorization": f"Bearer {admin}"}, {"Authorization": f"Bearer {other}"}
    name = f"test-model-{uuid.uuid4().hex[:6]}"
    created: list[str] = []
    async with httpx.AsyncClient(base_url=BASE, timeout=30) as c:
        check("anonymous callers are refused", (await c.get("/eval/models")).status_code == 401)
        check("an ordinary user is refused", (await c.get("/eval/models", headers=O)).status_code == 403)
        check("an ordinary user cannot register a model", (await c.post("/eval/models", headers=O, json={"provider": "openai", "model_id": name})).status_code == 403)

        r = await c.get("/eval/models", headers=A)
        labels = {m["label"]: m for m in r.json()}
        check("the registry lists the seeded models", r.status_code == 200 and "openai/gpt-4o-mini" in labels and "mock/mock-oracle" in labels, str(list(labels)[:5]))
        check("scripted models are marked synthetic and cost nothing", labels["mock/mock-oracle"]["synthetic"] and labels["mock/mock-oracle"]["current_price"]["output_per_m"] == 0)
        check("a real model has a priced, sourced current price", labels["openai/gpt-4o-mini"]["current_price"]["source"].startswith("Token Economy"))

        body = {"provider": "openai", "model_id": name, "display_name": "Test model", "capabilities": {"streaming": True, "context_window": 128000},
                "configuration": {"temperature": 0.2, "max_tokens": 800}, "price": {"input_per_m": 1.0, "cached_per_m": 0.5, "output_per_m": 4.0, "source": "unit test"}}
        r = await c.post("/eval/models", headers=A, json=body)
        mid = r.json().get("id")
        created.append(mid)
        check("a model can be registered with its first price", r.status_code == 201 and r.json()["current_price"]["output_per_m"] == 4.0, r.text)
        check("registering the same provider and model again is a conflict", (await c.post("/eval/models", headers=A, json=body)).status_code == 409)

        for what, bad in (("an unknown provider", {**body, "model_id": name + "a", "provider": "acme"}),
                          ("a model id with a space", {**body, "model_id": "bad id"}),
                          ("a real model marked synthetic can't exist: mock with a price", {"provider": "mock", "model_id": name + "m", "price": {"input_per_m": 1, "cached_per_m": 0, "output_per_m": 1, "source": "x"}}),
                          ("a setting that does nothing", {**body, "model_id": name + "b", "configuration": {"colour": "red"}}),
                          ("a temperature out of range", {**body, "model_id": name + "c", "configuration": {"temperature": 9}}),
                          ("a price without a source", {**body, "model_id": name + "d", "price": {"input_per_m": 1, "cached_per_m": 0, "output_per_m": 1, "source": " "}}),
                          ("a cached price above the input price", {**body, "model_id": name + "e", "price": {"input_per_m": 1, "cached_per_m": 2, "output_per_m": 1, "source": "x"}}),
                          ("a negative price", {**body, "model_id": name + "f", "price": {"input_per_m": -1, "cached_per_m": 0, "output_per_m": 1, "source": "x"}}),
                          ("an unknown capability", {**body, "model_id": name + "g", "capabilities": {"telepathy": True}})):
            check(f"refused: {what}", (await c.post("/eval/models", headers=A, json=bad)).status_code == 422)

        later = (datetime.utcnow() + timedelta(days=1)).isoformat()
        r = await c.post(f"/eval/models/{mid}/prices", headers=A, json={"input_per_m": 2.0, "cached_per_m": 1.0, "output_per_m": 8.0, "source": "unit test v2", "effective_from": later})
        check("a new price is appended", r.status_code == 201)
        r = await c.get(f"/eval/models/{mid}", headers=A)
        d = r.json()
        check("the price history keeps both, newest first", [p["output_per_m"] for p in d["price_history"]] == [8.0, 4.0], str(d.get("price_history")))
        check("a price that starts tomorrow is not the current one yet", d["current_price"]["output_per_m"] == 4.0)
        check("prices cannot be edited or deleted", (await c.put(f"/eval/models/{mid}/prices", headers=A, json={})).status_code == 405
              and (await c.delete(f"/eval/models/{mid}/prices/{d['price_history'][0]['id']}", headers=A)).status_code in (404, 405))

        r = await c.patch(f"/eval/models/{mid}", headers=A, json={"status": "deprecated", "provider": "anthropic", "model_id": "other", "configuration": {"temperature": 0}})
        d = r.json()
        check("status and configuration can change", r.status_code == 200 and d["status"] == "deprecated" and d["configuration"] == {"temperature": 0}, r.text)
        check("the provider and model id cannot change", d["provider"] == "openai" and d["model_id"] == name)
        check("a bad status is refused", (await c.patch(f"/eval/models/{mid}", headers=A, json={"status": "gone"})).status_code == 422)
        check("an unknown model is 404", (await c.get(f"/eval/models/{uuid.uuid4()}", headers=A)).status_code == 404)

        check("the registry can be filtered by provider", {m["provider"] for m in (await c.get("/eval/models?provider=mock", headers=A)).json()} == {"mock"})
        check("the registry can be filtered by role", all("judge" in m["roles"] for m in (await c.get("/eval/models?role=judge", headers=A)).json()))
        r = await c.get("/eval/benchmarks", headers=A)
        check("benchmarks list", r.status_code == 200 and isinstance(r.json(), list))
        check("an unknown benchmark is 404", (await c.get("/eval/benchmarks/nope", headers=A)).status_code == 404)
        check("benchmarks are not open to an ordinary user", (await c.get("/eval/benchmarks", headers=O)).status_code == 403)

    async with database._session_factory() as s:                     # leave the registry as it was
        for mid in created:
            await s.exec(delete(EvalModelPrice).where(EvalModelPrice.model_row_id == uuid.UUID(mid)))
            await s.exec(delete(EvalModel).where(EvalModel.id == uuid.UUID(mid)))
        await s.commit()
    print(f"\nmodel registry tests: {FAILS} failed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
