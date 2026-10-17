"""
OpenSanctions PEP/sanctions screening client.

Unlike payment_gateway.py (deliberately mocked — no real PSP credentials
exist), OpenSanctions (opensanctions.org) has a real, keyed REST API that
already aggregates Pakistan-relevant sources per the user's own research:
the general "default" collection includes Pakistani PEPs (National Assembly,
Senate, provincial assemblies, judiciary, military) *and* NACTA's proscribed
persons list (terrorism financing) in one place — so one integration covers
both the PEP and NACTA/sanctions asks without a second manual CSV pipeline.

Requires OPENSANCTIONS_API_KEY (get one at https://www.opensanctions.org/api/
— free for journalism/civil-society/academic use, paid trial otherwise). With
no key configured, `is_configured()` is False and the caller (compliance_engine)
falls back to the internal deterministic watchlist screen — same fallback
philosophy as risk_client.py degrading to manual review on any failure.

⚠️ The exact response field names below (caption/name, datasets, topics) are
based on OpenSanctions' published matching-API docs, not a live test against a
real key — no key exists in this environment to verify against. Parsing is
deliberately defensive (falls back to internal screening on any shape
mismatch, timeout, or non-200) so a wrong assumption here degrades gracefully
instead of crashing the compliance flow. Verify field names against a real
account before relying on this for production screening.
"""

import logging
import os
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger("tenant-service.pep-screening")

_API_BASE = os.getenv("OPENSANCTIONS_API_URL", "https://api.opensanctions.org")
_API_KEY = os.getenv("OPENSANCTIONS_API_KEY", "")
_COLLECTION = os.getenv("OPENSANCTIONS_COLLECTION", "default")
_TIMEOUT_SECONDS = 15.0
_MATCH_SCORE_THRESHOLD = float(os.getenv("OPENSANCTIONS_SCORE_THRESHOLD", "0.5"))


def is_configured() -> bool:
    return bool(_API_KEY)


async def screen_person(
    name: str,
    dob: Optional[str] = None,
    nationality: str = "pk",
) -> Optional[List[Dict[str, Any]]]:
    """Screen a person's name (+ optional DOB) against OpenSanctions' default
    collection (PEPs, sanctions, and — for Pakistan — NACTA proscribed persons).

    Returns a list of match dicts (possibly empty — a clean screen) on success,
    or None if the API is unconfigured/unreachable/malformed, signalling the
    caller to fall back to internal deterministic screening instead.
    """
    if not is_configured():
        return None
    if not name or not name.strip():
        return []

    properties: Dict[str, list] = {"name": [name.strip()], "nationality": [nationality]}
    if dob:
        properties["birthDate"] = [dob]

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                f"{_API_BASE}/match/{_COLLECTION}",
                json={"queries": {"q1": {"schema": "Person", "properties": properties}}},
                headers={"Authorization": f"ApiKey {_API_KEY}"},
            )
    except (httpx.TimeoutException, httpx.ConnectError) as exc:
        logger.warning("OpenSanctions unreachable for '%s': %s: %s", name, type(exc).__name__, exc or "(no detail)")
        return None

    if resp.status_code != 200:
        logger.warning("OpenSanctions returned %s for '%s': %s", resp.status_code, name, resp.text[:500])
        return None

    try:
        payload = resp.json()
        raw_results = payload["responses"]["q1"]["results"]
    except (KeyError, ValueError, TypeError) as exc:
        logger.warning("Unexpected OpenSanctions response shape for '%s': %s", name, exc)
        return None

    matches: List[Dict[str, Any]] = []
    for entity in raw_results:
        score = float(entity.get("score", 0) or 0)
        if score < _MATCH_SCORE_THRESHOLD:
            continue
        props = entity.get("properties", {}) or {}
        matches.append({
            "matched_name": entity.get("caption") or entity.get("name") or name,
            "score": round(score * 100, 1) if score <= 1 else round(score, 1),
            "datasets": entity.get("datasets", []),
            "topics": props.get("topics", entity.get("topics", [])),
            "id": entity.get("id"),
            "source_url": f"https://www.opensanctions.org/entities/{entity.get('id')}/" if entity.get("id") else None,
        })

    matches.sort(key=lambda m: m["score"], reverse=True)
    return matches[:5]
