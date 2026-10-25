"""Calls every route with NO credentials and dummy ids, directly on the tenant service and through the API gateway, and prints JSON {key: {direct, gateway, via_gateway}}.
Run it ONLY on the isolated evaluation stack (a route that is wrongly open can then change only the throwaway database):

    docker exec -i eval-tenant-service python -B -W ignore - < evals/security/anon_probe.py < routes.json     (routes on stdin as JSON, base urls in env)

via_gateway is True when the gateway forwarded the call (anything but the gateway's own 404/405 for an unknown route)."""
import asyncio
import json
import os
import re
import sys
import uuid

import httpx

DIRECT = os.environ.get("DIRECT", "http://localhost:8001")
GATEWAY = os.environ.get("GATEWAY", "http://eval-api-gateway:8000")


def fill(path):
    return re.sub(r"\{([^}:]+)(?::[^}]*)?\}", lambda m: str(uuid.uuid4()) if m.group(1).endswith("id") else "x", path)


async def one(c, base, m, p):
    try:
        r = await c.request(m, base + fill(p), json={} if m != "GET" else None)
        try:
            detail = r.json().get("detail") if r.headers.get("content-type", "").startswith("application/json") else None
        except Exception:
            detail = None
        return r.status_code, detail if isinstance(detail, str) else None
    except Exception as e:
        return "ERR", type(e).__name__


async def main():
    routes = json.load(open(os.environ["ROUTES"]))
    out = {}
    sem = asyncio.Semaphore(8)
    async with httpx.AsyncClient(timeout=30, follow_redirects=False) as c:
        async def job(x):
            async with sem:
                m, p = x["method"], x["path"]
                if p.startswith("/internal"):
                    return
                d = await one(c, DIRECT, m, p)
                g = await one(c, GATEWAY, m, p)
                own_404 = g[0] in (404, 405) and (g[1] in ("Not Found", "Method Not Allowed", None))
                out[f"{m} {p}"] = {"direct": d, "gateway": g, "via_gateway": not own_404}
        await asyncio.gather(*(job(x) for x in routes))
    json.dump(out, sys.stdout)

asyncio.run(main())
