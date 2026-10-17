"""Availability tools: get_service_health and diagnose_connection
(docs/agent-scenarios/chatbot-maturity-roadmap.md, P0).

Both are read-only. They probe each service's own health endpoint from inside
the platform network and never restart anything — restarting infrastructure
stays an explicit staff operation outside the chat.

diagnose_connection exists because "sign in failed — the server took too long"
has four very different causes that look identical on a phone: the device
cannot reach the gateway at all (wrong address, different network), the API
address is mistyped, a service is down, or the credentials are wrong. It
separates them from the symptom, live health, and the address the app uses.

Registered by being imported at the foot of tool_executor.py.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import time
from typing import Optional
from urllib.parse import urlparse

import httpx

from tool_executor import API_GATEWAY_URL, TENANT_SERVICE_URL, Ctx, handles

_ADMIN = {"Admin", "SuperAdmin"}
_PROBE_TIMEOUT = 4.0
_SLOW_MS = 1500
# The host port the gateway is published on (docker-compose maps 8010 -> 8000).
GATEWAY_PUBLIC_PORT = int(os.environ.get("GATEWAY_PUBLIC_PORT", "8010"))

# key -> (label, health URL)
SERVICES: dict[str, tuple[str, str]] = {
    "api_gateway": ("API Gateway (sign-in and every app)", f"{API_GATEWAY_URL}/health"),
    "tenant_service": ("Core platform", f"{TENANT_SERVICE_URL}/health"),
    "risk_engine": ("Risk engine", os.environ.get("RISK_ENGINE_URL", "http://risk-engine:8002") + "/health"),
    "ocr_engine": ("Document reading (OCR)", os.environ.get("OCR_ENGINE_URL", "http://ocr-engine:8004") + "/health"),
    "customer_service": ("Customer Service",
                         os.environ.get("CUSTOMER_SERVICE_URL", "http://customer-service:8008") + "/v1/healthz"),
    "request_management": ("Request Management",
                           os.environ.get("REQUEST_MANAGEMENT_SERVICE_URL",
                                          "http://request-management-service:8007") + "/v1/healthz"),
    "customer_management": ("Customer Management",
                            os.environ.get("CUSTOMER_MANAGEMENT_URL", "http://customer-management:8009") + "/v1/healthz"),
}

_APP_SERVICE = {"customer_service": "customer_service", "customer_portal": "customer_management"}


async def probe(client: httpx.AsyncClient, url: str) -> dict:
    started = time.monotonic()
    try:
        res = await client.get(url, timeout=_PROBE_TIMEOUT)
        ms = round((time.monotonic() - started) * 1000)
        if res.status_code >= 400:
            return {"status": "unhealthy", "http_status": res.status_code, "latency_ms": ms}
        return {"status": "degraded" if ms > _SLOW_MS else "healthy", "latency_ms": ms}
    except httpx.TimeoutException:
        return {"status": "timeout", "latency_ms": round(_PROBE_TIMEOUT * 1000)}
    except httpx.RequestError as exc:
        return {"status": "unreachable", "detail": type(exc).__name__}


async def check_services(keys: list[str]) -> dict[str, dict]:
    async with httpx.AsyncClient(follow_redirects=False) as client:
        results = await asyncio.gather(*(probe(client, SERVICES[k][1]) for k in keys))
    return dict(zip(keys, results))


_ICON = {"healthy": "🟢", "degraded": "🟡", "unhealthy": "🔴", "timeout": "🔴", "unreachable": "🔴"}
_WORD = {"healthy": "available", "degraded": "slow", "unhealthy": "failing", "timeout": "not responding",
         "unreachable": "down"}


def _row(key: str, result: dict, admin: bool) -> dict:
    row = {"service": key, "label": SERVICES[key][0], "status": result["status"],
           "latency_ms": result.get("latency_ms")}
    if admin:
        row["url"] = SERVICES[key][1]
        row.update({k: v for k, v in result.items() if k in ("http_status", "detail")})
    return row


@handles("get_service_health")
async def _get_service_health(args: dict, ctx: Ctx) -> dict:
    keys = [args["service"]] if args.get("service") in SERVICES else list(SERVICES)
    admin = ctx.exec_ctx.role in _ADMIN
    checked = await check_services(keys)
    rows = [_row(k, checked[k], admin) for k in keys]
    down = [r for r in rows if r["status"] not in ("healthy", "degraded")]
    lines = "\n".join(
        f"- {_ICON[r['status']]} **{r['label']}** — {_WORD[r['status']]}"
        + (f" ({r['latency_ms']} ms)" if r.get("latency_ms") is not None and r["status"] in ("healthy", "degraded") else "")
        for r in rows)
    if down:
        head = f"{len(down)} service(s) unavailable right now."
        head += (" Restarting a service is a staff operation outside the chat — e.g. `docker compose restart "
                 f"{down[0]['service'].replace('_', '-')}` on the host." if admin else
                 " Please let your administrator know.")
    else:
        head = "All checked services are available."
    return {"success": True, "services": rows, "message": f"{head}\n{lines}",
            "result": {"status": "completed", "unavailable": [r["service"] for r in down]}}


# ── diagnose_connection ─────────────────────────────────────────────────────

_TIMEOUT_WORDS = ("took too long", "timed out", "timeout", "time out", "taking too long")
_NETWORK_WORDS = ("network error", "network request failed", "unreachable", "connection refused", "failed to fetch",
                  "could not connect", "can't connect", "cannot connect", "no internet", "err_connection")
_CREDENTIAL_WORDS = ("invalid credentials", "incorrect password", "wrong password", "invalid password",
                     "unauthorized", "401", "invalid email", "user not found", "incorrect email")
_SERVER_WORDS = ("500", "502", "503", "504", "service unavailable", "bad gateway", "internal server error",
                 "something went wrong")

_PRIVATE = [ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")]


def _private(ip: ipaddress.IPv4Address) -> bool:
    return any(ip in n for n in _PRIVATE)


def check_api_url(raw: str, app: Optional[str]) -> list[str]:
    """Static problems with the address an app is configured with."""
    problems: list[str] = []
    url = urlparse(raw.strip() if "://" in raw else f"http://{raw.strip()}")
    host, port = url.hostname or "", url.port
    if url.scheme not in ("http", "https"):
        problems.append(f"The address must start with http:// or https:// (it uses “{url.scheme}”).")
    if host in ("localhost", "127.0.0.1", "0.0.0.0") and app == "mobile_agent_app":
        problems.append(f"“{host}” on a phone means the phone itself, not the server. Use the server computer's "
                        "network IP address instead (e.g. http://192.168.x.x:%d)." % GATEWAY_PUBLIC_PORT)
    try:
        ip = ipaddress.IPv4Address(host)
    except ValueError:
        ip = None
    if ip is not None and not _private(ip) and not ip.is_loopback:
        # A public address where a LAN one is expected is usually a typo of one:
        # 110.47.153.234 for 10.47.153.234, 1192.168… and so on.
        text = str(ip)
        for cut in (1, 2):
            try:
                candidate = ipaddress.IPv4Address(text[cut:])
            except ValueError:
                continue
            if _private(candidate):
                problems.append(f"{text} is a public internet address, not a local network one — it looks like a "
                                f"typo of {candidate} (an extra leading digit).")
                break
        else:
            problems.append(f"{text} is a public internet address. For a development server the app normally uses "
                            "the server computer's local network address (10.x, 172.16–31.x or 192.168.x).")
    if port is not None and port != GATEWAY_PUBLIC_PORT and app == "mobile_agent_app":
        problems.append(f"The API gateway is published on port {GATEWAY_PUBLIC_PORT}, but the address uses port {port}.")
    return problems


async def _probe_client_url(raw: str) -> Optional[dict]:
    """Reach the app's configured gateway from the server side. Restricted to
    private addresses and the fixed /health path, so the chat cannot be used to
    fetch arbitrary URLs."""
    url = urlparse(raw.strip() if "://" in raw else f"http://{raw.strip()}")
    try:
        ip = ipaddress.IPv4Address(url.hostname or "")
    except ValueError:
        return None
    if not _private(ip):
        return None
    async with httpx.AsyncClient(follow_redirects=False) as client:
        return await probe(client, f"{url.scheme}://{ip}:{url.port or 80}/health")


def _symptom_kind(symptom: str) -> str:
    s = symptom.lower()
    for kind, words in (("credentials", _CREDENTIAL_WORDS), ("timeout", _TIMEOUT_WORDS),
                        ("network", _NETWORK_WORDS), ("server_error", _SERVER_WORDS)):
        if any(w in s for w in words):
            return kind
    return "unknown"


@handles("diagnose_connection")
async def _diagnose_connection(args: dict, ctx: Ctx) -> dict:
    symptom, app = args.get("symptom") or "", args.get("app")
    admin = ctx.exec_ctx.role in _ADMIN
    keys = ["api_gateway", "tenant_service"] + ([_APP_SERVICE[app]] if app in _APP_SERVICE else [])
    checked = await check_services(keys)
    gateway_ok = checked["api_gateway"]["status"] in ("healthy", "degraded")
    platform_ok = all(checked[k]["status"] in ("healthy", "degraded") for k in keys)
    kind = _symptom_kind(symptom)

    url_problems = check_api_url(args["client_api_url"], app) if args.get("client_api_url") else []
    client_probe = await _probe_client_url(args["client_api_url"]) if args.get("client_api_url") else None

    steps: list[str] = []
    if not platform_ok:
        down = [SERVICES[k][0] for k in keys if checked[k]["status"] not in ("healthy", "degraded")]
        diagnosis, title = "service_unavailable", f"The server side is down: {', '.join(down)}."
        steps.append("Nothing on the device will fix this — the service has to be brought back by staff."
                     + (" Check its logs, then restart it on the host." if admin else " Let your administrator know."))
    elif kind == "credentials":
        diagnosis, title = "invalid_credentials", "The server is up and answered — the email or password was not accepted."
        steps += ["Check the email for typos and that Caps Lock is off.",
                  "Use the account's own login (an Agent account for the agent app).",
                  "If it still fails, an administrator can reset the password."]
    elif url_problems:
        diagnosis, title = "misconfigured_api_url", "The app is pointed at the wrong server address."
        steps += url_problems
        steps.append("Fix the address (for the agent app, EXPO_PUBLIC_API_URL in agent-app/.env), then restart the "
                     "bundler with its cache cleared — `npx expo start -c` — so the new value is built in.")
    elif kind in ("timeout", "network"):
        diagnosis = "device_cannot_reach_gateway"
        title = ("The server is healthy, so the device is not reaching it — the request never arrived and the app "
                 "gave up waiting." if kind == "timeout" else "The server is healthy, but the device cannot connect to it.")
        # Only a successful probe is evidence: a container often cannot reach its own host's LAN
        # address (Docker Desktop), so a failed probe says nothing about the address itself.
        if client_probe and client_probe["status"] in ("healthy", "degraded"):
            steps.append("That address works from the server's network, so the device is most likely on a different "
                         "network: put the phone on the same Wi-Fi as the server (not mobile data or a guest network).")
        else:
            steps += ["Make sure the phone is on the same Wi-Fi as the server computer (not mobile data).",
                      "Check the app's API address is the server computer's current network IP and port "
                      f"{GATEWAY_PUBLIC_PORT} — it changes when the computer joins a different network."]
        steps.append("A firewall on the server computer can also block the port — allow incoming connections on "
                     f"{GATEWAY_PUBLIC_PORT}.")
    elif kind == "server_error":
        diagnosis, title = "backend_error", "The server answered with an error, though its health checks pass now."
        steps.append("Try again; if it repeats, note the time and share it with your administrator so the logs can be checked.")
    else:
        diagnosis, title = "no_fault_found", "All checked services are healthy and nothing in the symptom points to a cause."
        steps.append("Tell me the exact message the app shows, and the API address it is configured with, and I can narrow it down.")

    if checked["api_gateway"]["status"] == "degraded" and diagnosis not in ("service_unavailable",):
        steps.append(f"Note: the gateway is responding slowly ({checked['api_gateway'].get('latency_ms')} ms).")

    health = [_row(k, checked[k], admin) for k in keys]
    msg = f"**{title}**\n\n" + "\n".join(f"{i}. {s}" for i, s in enumerate(steps, 1))
    return {
        "success": True,
        "diagnosis": diagnosis,
        "services": health,
        "result": {"status": "completed", "diagnosis": diagnosis, "symptom_kind": kind,
                   "gateway_reachable_from_server": gateway_ok,
                   "client_url_problems": url_problems,
                   # True, or None when unknown — never False (see the probe note above).
                   "client_url_reachable_from_server": True if client_probe
                   and client_probe["status"] in ("healthy", "degraded") else None},
        "message": msg,
    }
