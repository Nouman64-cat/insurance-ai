"""
Risk Engine client — synchronous HTTP call used only for group/corporate life
insurance members whose coverage exceeds their MasterPolicy's Free Cover Limit
(see routers/organizations.py's confirm_employee_census).

At-or-under-FCL members are guaranteed-issue and never reach this module —
this is deliberately a thin wrapper around risk-engine's plain POST /evaluate
(not /evaluate/stream, which is SSE and meant for browser clients), following
the same plain os.getenv + httpx.AsyncClient convention ocr_worker.py already
uses for calling a sibling service — tenant-service has no DI/Settings
framework like api-gateway's dependencies.py.

Any failure (timeout, connection error, or a non-200 response — risk-engine
returns 422 when its own input validation fails) returns None rather than
raising, so one bad call degrades that one employee to manual review instead
of failing the whole census-confirm batch.
"""

import logging
import os
from typing import Any, Dict, Optional

import httpx

logger = logging.getLogger("tenant-service.risk-client")

RISK_ENGINE_URL = os.getenv("RISK_ENGINE_URL", "http://risk-engine:8002")
# Generous: risk-engine's LangGraph pipeline makes 3 sequential LLM calls
# (medical/financial/fraud scoring), each several seconds — and slower still
# under concurrent load (multiple above-FCL employees evaluated at once, see
# _RISK_ENGINE_CONCURRENCY in routers/organizations.py) since they compete for
# the same LLM rate-limit budget. A tight timeout here just means more
# employees silently degrade to manual review for no real reason.
_TIMEOUT_SECONDS = 90.0


async def evaluate_group_member(
    customer_payload: Dict[str, Any],
    policy_payload: Dict[str, Any],
    tenant_id: str,
) -> Optional[Dict[str, Any]]:
    """Call risk-engine's POST /evaluate for one above-FCL group member.

    `policy_payload["term_years"]` is expected to already be forced to 1 by
    the caller (risk-engine's GROUP_LIFE band is min_term_years=max_term_years=1,
    an annually-renewable certificate — independent of the MasterPolicy's own
    admin-entered, potentially multi-year, contract term).

    Returns the parsed EvaluationResponse dict (is_valid, medical_score,
    financial_score, fraud_probability, composite_risk_score, ai_decision,
    suggested_loading, reasons) or None on any failure.
    """
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                f"{RISK_ENGINE_URL}/evaluate",
                json={"customer": customer_payload, "policy": policy_payload},
                headers={"X-Tenant-Id": tenant_id},
            )
    except (httpx.TimeoutException, httpx.ConnectError) as exc:
        logger.warning(
            "risk-engine unreachable for group member | cnic=%s error=%s: %s",
            customer_payload.get("cnic"), type(exc).__name__, exc or "(no detail)",
        )
        return None

    if resp.status_code != 200:
        logger.warning(
            "risk-engine returned %s for group member | cnic=%s body=%s",
            resp.status_code, customer_payload.get("cnic"), resp.text[:500],
        )
        return None

    return resp.json()
