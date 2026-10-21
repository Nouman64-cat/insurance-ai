"""Audit capture for tenant-service: every significant business change becomes an audit intent, atomically.

How an operation gets audited, with no change to the router that performs it:

  1. AuditContextMiddleware (pure ASGI) reads the caller's session once per request and records who is acting
     (user id, name, role, tenant) and the request's correlation id in a ContextVar.
  2. An SQLAlchemy `after_flush` hook looks at the rows the business transaction is inserting, updating or deleting.
     For the models in SPECS it writes an audit intent into `audit_outbox` *on the same connection and transaction*.
     The change and its audit intent therefore commit together or roll back together; if the intent cannot be
     written the business transaction fails with it, so nothing is ever reported as audited that wasn't.
  3. OutboxRelay (shared/audit/outbox.py) publishes committed intents to Kafka; the Audit Service assigns sequence
     numbers and hashes. The business request never waits on Kafka or the Audit Service.

Events that are not a row change (sign-in, denied access, document viewing) use record() inside the caller's
transaction, or record_standalone() when there is no business transaction to join (a failed sign-in).

Sensitive data: values are sanitized (shared/audit/sanitize.py) and each spec can list fields that are noted as
"changed" without their value (`summarize`). Credentials, tokens, raw document/medical content and personal
identifiers never reach the outbox.

Known gap: bulk `UPDATE`/`DELETE` statements issued through the Core/ORM-enabled `update()` or raw SQL bypass the
ORM flush and are not captured here.
"""
import asyncio
import logging
import os
import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Mapping, Optional
from uuid import UUID

from sqlalchemy import event, inspect, text
from sqlalchemy.orm import Session

from shared.audit import schema as S
from shared.audit.context import AuditContext, get_context, reset_context, set_context
from shared.audit.outbox import OutboxRelay, build_intent, enqueue, enqueue_sync

log = logging.getLogger("tenant-service.audit")

SERVICE = "tenant-service"
ENABLED = os.environ.get("AUDIT_ENABLED", "true").strip().lower() not in ("0", "false", "no", "off")

_COMMON_IGNORE = frozenset({"updated_at", "updatedAt", "created_at", "createdAt", "lastUpdatedAt", "last_updated_at", "last_login_at"})
_JSON_NOTE_BYTES = 600


def snake(value: Any) -> str:
    if isinstance(value, Enum):
        value = value.value
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", str(value))
    return re.sub(r"[^A-Za-z0-9]+", "_", spaced).strip("_").lower()[:60]


@dataclass(frozen=True)
class Spec:
    module: str
    entity: str                                             # entity_type; also the action prefix: <entity>.created
    pk: str = "id"
    tenant: Optional[str] = "tenant_id"                     # attribute with the tenant id; "@self": the row is the tenant; None: platform
    tenant_via: Optional[tuple[str, str, str]] = None       # (table, its key column, our foreign-key attribute) when we have no tenant column
    case: Optional[str] = None                              # attribute holding the case id
    actor: Optional[str] = None                             # attribute naming who acted, when the row itself records it
    status: Optional[str] = None                            # a change to it is named <entity>.status_changed
    insert_only: bool = False                               # an append-only log: only its creation is an event
    ignore: frozenset = _COMMON_IGNORE
    summarize: frozenset = frozenset()                      # changes are noted, values are never stored
    keep: Optional[frozenset] = None                        # if set, only these attributes appear in values
    renames: Mapping[str, str] = field(default_factory=dict)  # sole changed attribute -> action suffix
    action: Optional[Callable[[dict], str]] = None          # semantic action for a creation (insert-only logs)
    platform_on_create: bool = False                        # the creation belongs to the platform chain (a new tenant)


_SPECS: Optional[dict[type, Spec]] = None


def specs() -> dict[type, Spec]:
    """Model -> Spec. Built lazily so importing this module never imports the models."""
    global _SPECS
    if _SPECS is not None:
        return _SPECS
    import shared.models.commission as M
    import shared.models.core as C
    a, c, d, p, pay, cl, u, ai = (S.ADMINISTRATION, S.CUSTOMERS_LEADS, S.DOCUMENTS, S.POLICIES, S.PAYMENTS, S.CLAIMS, S.UNDERWRITING, S.AI_AGENTS)
    via_case = ("cases", "caseld", "caseld")
    _SPECS = {
        # ── Administration ────────────────────────────────────────────────────────────
        C.User: Spec(a, "user", status="status", ignore=_COMMON_IGNORE | {"last_login", "failed_login_count", "is_verified"},
                     renames={"hashed_password": "password_changed", "role_id": "role_changed", "is_active": "activation_changed", "is_deleted": "removed"}),
        C.Role: Spec(a, "role", tenant=None),
        C.Tenant: Spec(a, "tenant", tenant="@self", platform_on_create=True),
        C.Branch: Spec(a, "branch"),
        C.LLMProviderConfig: Spec(a, "llm_config", tenant=None),
        C.LLMTaskModel: Spec(a, "llm_task_model", tenant=None),
        C.PlatformAgentConfig: Spec(ai, "agent_config", tenant=None),
        C.RuleSet: Spec(a, "rule_set", status=None),
        C.RuleVersion: Spec(a, "rule_version", tenant=None, tenant_via=("rule_sets", "id", "rule_set_id"), status="status"),
        # ── Customers & leads ─────────────────────────────────────────────────────────
        C.Customer: Spec(c, "customer", renames={"assigned_agent_id": "assigned", "profile_status": "profile_status_changed"},
                         summarize=frozenset({"details", "height_cm", "weight_kg", "is_smoker", "declared_income", "marital_status", "occupation"})),
        C.Organization: Spec(c, "organization", renames={"assigned_agent_id": "assigned"}),
        C.AcquisitionSource: Spec(c, "acquisition_source"),
        C.WalkInLead: Spec(c, "lead", status="routing_status", renames={"assigned_agent_id": "assigned"},
                           summarize=frozenset({"household_json", "message"})),
        C.WalkInLeadEvent: Spec(c, "lead_event", insert_only=True, actor="actor", action=lambda v: f"lead.{snake(v.get('event_type'))}"),
        # ── Underwriting ──────────────────────────────────────────────────────────────
        C.Case: Spec(u, "case", pk="caseld", case="caseld", status="caseStatus", renames={"assignedAgentId": "assigned", "on_hold": "hold_changed"},
                     summarize=frozenset({"held_by"})),
        C.CaseHistory: Spec(u, "case_history", pk="historyld", tenant=None, tenant_via=via_case, case="caseld", actor="changedBy",
                            insert_only=True, action=lambda v: f"case.history.{snake(v.get('actionType'))}"),
        C.CaseAuditTrail: Spec(u, "case_audit", pk="auditld", tenant=None, tenant_via=via_case, case="caseld", actor="performedBy",
                               insert_only=True, action=lambda v: f"case.audit.{snake(v.get('actionPerformed'))}"),
        C.CaseAssignment: Spec(u, "case_assignment", pk="assignmentld", tenant=None, tenant_via=via_case, case="caseld", status="assignmentStatus"),
        C.CaseEscalation: Spec(u, "case_escalation", pk="escalationld", tenant=None, tenant_via=via_case, case="caseld", status="resolutionStatus"),
        C.CaseUnderwritingTrack: Spec(u, "underwriting_track", case="case_id", status="status", summarize=frozenset({"ai_result", "note"})),
        C.CounterOffer: Spec(u, "counter_offer", status="status", summarize=frozenset({"exclusions_json", "response_note"})),
        C.MedicalExamOrder: Spec(u, "medical_exam", case="case_id", status="status",
                                 summarize=frozenset({"trigger_reasons", "required_tests", "appointment_note", "waiver_reason", "lab_signer_license"})),
        C.ReinsuranceReferral: Spec(u, "reinsurance_referral", case="case_id", status="status", summarize=frozenset({"slip_json", "reinsurer_conditions", "imposed_exclusions"})),
        C.AgentConfidentialReport: Spec(u, "agent_confidential_report", case="case_id", status="status",
                                        keep=frozenset({"status", "agent_id", "requested_at", "requested_by", "submitted_at", "waived_by", "waived_at", "recommendation"})),
        C.CustomerEApplication: Spec(u, "e_application", case="case_id", status="status",
                                     keep=frozenset({"status", "customer_id", "sent_at", "sent_by", "started_at", "submitted_at", "verified_at", "verified_by"})),
        # ── AI agents ─────────────────────────────────────────────────────────────────
        C.RiskAssessment: Spec(ai, "risk_assessment", case="case_id",
                               keep=frozenset({"customer_id", "policy_id", "correlation_id", "medical_score", "financial_score", "fraud_probability",
                                               "composite_risk_score", "ai_decision", "suggested_loading", "superseded_at", "superseded_reason"})),
        C.TokenUsage: Spec(ai, "llm_invocation", insert_only=True, action=lambda v: "ai.llm.invoked",
                           keep=frozenset({"service_name", "model_name", "thread_id", "input_tokens", "output_tokens", "total_tokens", "cached_tokens", "audio_seconds"})),
        # ── Documents ─────────────────────────────────────────────────────────────────
        C.Artifact: Spec(d, "artifact", case="case_id", status="status", ignore=_COMMON_IGNORE | {"storage_url"},
                         summarize=frozenset({"ocr_result", "extracted_metadata"})),
        C.DocumentRequest: Spec(d, "document_request", ignore=_COMMON_IGNORE | {"token_version"}),
        # ── Policies ──────────────────────────────────────────────────────────────────
        C.Policy: Spec(p, "policy", status="status", summarize=frozenset({"demo_bypass_flags"})),
        C.PolicyEvent: Spec(p, "policy_event", insert_only=True, actor="actor", action=lambda v: f"policy.lifecycle.{snake(v.get('event_type'))}"),
        C.PolicyEndorsement: Spec(p, "endorsement", summarize=frozenset({"detail_json"})),
        C.PolicyReinstatement: Spec(p, "reinstatement", status="status", summarize=frozenset({
            "eligibility_json", "rules_json", "arrears_json", "declaration_json", "evidence_json", "assessment_json", "terms_json",
            "decision_history_json", "receipts_json", "reason", "decision_notes"})),
        C.PolicyRenewal: Spec(p, "renewal", status="status", summarize=frozenset({
            "eligibility_json", "rules_json", "quote_json", "risk_json", "reconciliation_json", "risk_notes", "reconciliation_note"})),
        C.PolicyExit: Spec(p, "policy_exit", status="status", summarize=frozenset({
            "rules_json", "extension_json", "eligibility_json", "documents_json", "consent_json", "settlement_json", "payee_json",
            "payouts_json", "reconciliation_json", "coverage_update_json", "reason"})),
        C.PolicyLoan: Spec(p, "policy_loan", status="status", summarize=frozenset({"note"})),
        C.Beneficiary: Spec(p, "beneficiary"),
        C.MasterPolicy: Spec(p, "master_policy", status="status"),
        C.GroupEndorsement: Spec(p, "group_endorsement", status="status", summarize=frozenset({"lines"})),
        C.GroupRenewal: Spec(p, "group_renewal", status="status", summarize=frozenset({"experience", "census_refresh", "notes"})),
        # ── Payments & commissions ────────────────────────────────────────────────────
        C.InitialPremiumPayment: Spec(pay, "premium_payment", case="case_id", status="status",
                                      summarize=frozenset({"breakdown_json", "proof_note", "proof_review_note"})),
        C.PremiumReceipt: Spec(pay, "premium_receipt", insert_only=True),
        C.PremiumSchedule: Spec(pay, "premium_schedule", tenant=None, tenant_via=("policies", "id", "policy_id"), status="status"),
        M.CommissionAgreement: Spec(pay, "commission_agreement", status="status"),
        M.CommissionDisbursement: Spec(pay, "commission_disbursement", status="status"),
        M.CommissionDisbursementEvent: Spec(pay, "commission_disbursement_event", tenant=None, tenant_via=("commission_disbursements", "id", "batch_id"),
                                            insert_only=True, actor="actor_id", action=lambda v: f"commission.disbursement.{snake(v.get('action'))}",
                                            summarize=frozenset({"detail"})),
        M.CommissionAccrual: Spec(pay, "commission_accrual", status="status"),
        # ── Claims ────────────────────────────────────────────────────────────────────
        C.Claim: Spec(cl, "claim", case="case_id", status="status", summarize=frozenset({"underwriting_decision_notes", "underwriting_referral_reason"})),
        C.ClaimStatusHistory: Spec(cl, "claim_status_history", insert_only=True, actor="actor_id", summarize=frozenset({"notes"}),
                                   action=lambda v: f"claim.status.{snake(v.get('to_status'))}"),
        C.ClaimPayout: Spec(cl, "claim_payout", status="status", summarize=frozenset({"notes"})),
        C.ClaimUnderwritingCheck: Spec(cl, "claim_underwriting_check", case="case_id", summarize=frozenset({"note"})),
    }
    return _SPECS


# ── Counters (exposed by /health/audit) ─────────────────────────────────────────────────────────

@dataclass
class CaptureStats:
    captured: int = 0
    mapping_failures: int = 0
    standalone_failures: int = 0
    last_failure: Optional[str] = None


STATS = CaptureStats()


# ── Building intents from ORM state ────────────────────────────────────────────────────────────

def _plain(value: Any) -> Any:
    return value.value if isinstance(value, Enum) else value


def _bounded(value: Any) -> Any:
    """JSON-ish values larger than a note stay out of the ledger; the sanitizer handles everything else."""
    if isinstance(value, (dict, list)):
        import json
        try:
            size = len(json.dumps(value, default=str))
        except (TypeError, ValueError):
            return "[unserializable]"
        if size > _JSON_NOTE_BYTES:
            return f"[json {size} bytes]"
    return _plain(value)


def _shape(spec: Spec, values: Mapping[str, Any], marker: str = "[withheld]") -> dict:
    """The values to record. `summarize` fields are noted ("[changed]" on an update, "[withheld]" otherwise), never stored."""
    out = {}
    for key, value in values.items():
        if key in spec.ignore or (spec.keep is not None and key not in spec.keep):
            continue
        out[key] = marker if key in spec.summarize else _bounded(value)
    return out


def _uuid(value: Any) -> Optional[UUID]:
    if value is None:
        return None
    if isinstance(value, UUID):
        return value
    try:
        return UUID(str(value))
    except (ValueError, AttributeError):
        return None


def _tenant_of(spec: Spec, values: Mapping[str, Any], connection, ctx: AuditContext, cache: dict) -> Optional[UUID]:
    if spec.tenant == "@self":
        return _uuid(values.get(spec.pk))
    if spec.tenant:
        found = _uuid(values.get(spec.tenant))
        if found:
            return found
    if spec.tenant_via:
        table, key_col, attr = spec.tenant_via
        fk = values.get(attr)
        if fk is not None:
            cache_key = (table, str(fk))
            if cache_key not in cache:
                row = connection.execute(text(f'SELECT tenant_id FROM {table} WHERE "{key_col}" = :v'), {"v": fk}).first()
                cache[cache_key] = _uuid(row[0]) if row else None
            if cache[cache_key]:
                return cache[cache_key]
    return ctx.tenant_id if spec.tenant is not None or spec.tenant_via else None


def _row_actor(spec: Spec, values: Mapping[str, Any], ctx: AuditContext) -> dict:
    """Actor fields: the row's own record of who acted if it has one, else the request's caller."""
    raw = values.get(spec.actor) if spec.actor else None
    if raw is None:
        return {}
    text_value = str(raw)
    if _uuid(text_value):
        role = ctx.actor_role if ctx.actor_id == text_value else None
        return {"actor_id": text_value, "actor_type": "USER", "actor_role": role}
    return {"label": text_value[:60]}  # a label such as "system" or "gateway": kept as metadata, the request's caller stays the actor


def _state_values(obj) -> dict:
    """The row's loaded column values, without triggering any lazy load."""
    state = inspect(obj)
    return {attr.key: state.dict[attr.key] for attr in state.mapper.column_attrs if attr.key in state.dict}


def _changes(obj) -> tuple[dict, dict]:
    state = inspect(obj)
    before, after = {}, {}
    for attr in state.mapper.column_attrs:
        history = state.attrs[attr.key].history
        if not history.has_changes():
            continue
        after[attr.key] = history.added[0] if history.added else None
        before[attr.key] = history.deleted[0] if history.deleted else None
    return before, after


def _intent_for(op: str, obj, spec: Spec, connection, ctx: AuditContext, cache: dict):
    values = _state_values(obj)
    entity_id = values.get(spec.pk)
    if op == "update":
        before, after = _changes(obj)
        changed = [k for k in after if k not in spec.ignore]
        if not changed:
            return None
        if spec.keep is not None:
            changed = [k for k in changed if k in spec.keep]
            if not changed:
                return None
        previous, new = _shape(spec, {k: before[k] for k in changed}, "[changed]"), _shape(spec, {k: after[k] for k in changed}, "[changed]")
        if spec.status and spec.status in changed:
            action = f"{spec.entity}.status_changed"
        elif len(changed) == 1 and changed[0] in spec.renames:
            action = f"{spec.entity}.{spec.renames[changed[0]]}"
        else:
            action = f"{spec.entity}.updated"
        meta = {"changed_fields": sorted(changed)}
    elif op == "create":
        new, previous = _shape(spec, values), None
        action = spec.action(values) if spec.action else f"{spec.entity}.created"
        meta = {}
    else:
        previous, new = _shape(spec, values), None
        action = f"{spec.entity}.deleted"
        meta = {}

    tenant = _tenant_of(spec, values, connection, ctx, cache)
    if op == "create" and spec.platform_on_create:
        tenant = None
    elif tenant is None and (spec.tenant is not None or spec.tenant_via):
        # Never drop an event because its tenant is unknown: it goes to the platform chain, flagged for follow-up.
        meta["tenant_unresolved"] = True
    acting = _row_actor(spec, values, ctx)
    if "label" in acting:
        meta["actor_label"] = acting.pop("label")
    meta["table"] = obj.__tablename__
    return build_intent(
        SERVICE, module=spec.module, action=action, entity_type=spec.entity,
        entity_id=entity_id, tenant_id=tenant, case_id=values.get(spec.case) if spec.case else None,
        previous_value=previous, new_value=new, metadata=meta, context=ctx, **acting,
    )


def _after_flush(session: Session, flush_context) -> None:
    if not ENABLED or not (session.new or session.dirty or session.deleted):
        return
    registry = specs()
    ctx = get_context()
    pending = []
    try:
        connection = session.connection()
        cache: dict = {}
        for op, objects in (("create", session.new), ("update", session.dirty), ("delete", session.deleted)):
            for obj in list(objects):
                spec = registry.get(type(obj))
                if spec is None or (op != "create" and spec.insert_only):
                    continue
                if op == "update" and not session.is_modified(obj, include_collections=False):
                    continue
                intent = _intent_for(op, obj, spec, connection, ctx, cache)
                if intent is not None:
                    pending.append(intent)
    except Exception as exc:  # a bug in the mapping must not break business writes, but it is counted and logged loudly
        STATS.mapping_failures += 1
        STATS.last_failure = f"{type(exc).__name__}: {exc}"[:300]
        log.exception("audit capture could not map a change; it is NOT audited")
        pending = []
    for intent in pending:  # a failure to WRITE the intent propagates: the business transaction fails with it
        enqueue_sync(session.connection(), intent)
    STATS.captured += len(pending)


_installed = False


def install_capture() -> None:
    """Register the flush hook (once per process)."""
    global _installed
    if _installed or not ENABLED:
        return
    event.listen(Session, "after_flush", _after_flush)
    _installed = True
    log.info("audit capture installed")


# ── Explicit audit events ──────────────────────────────────────────────────────────────────────

async def record(session, *, module: str, action: str, entity_type: str, entity_id: Any = None, tenant_id: Optional[UUID] = None,
                 case_id: Any = None, previous_value: Optional[dict] = None, new_value: Optional[dict] = None,
                 outcome: str = S.SUCCESS, metadata: Optional[dict] = None, **actor) -> None:
    """An audit event for something that is not a row change (document viewed, sign-in...). Joins the session's
    transaction: it commits with the caller's work. Do not swallow its errors."""
    if not ENABLED:
        return
    await enqueue(session, build_intent(SERVICE, module=module, action=action, entity_type=entity_type, entity_id=entity_id,
                                        tenant_id=tenant_id, case_id=case_id, previous_value=previous_value, new_value=new_value,
                                        outcome=outcome, metadata=metadata, **actor))


async def record_standalone(*, module: str, action: str, entity_type: str, entity_id: Any = None, tenant_id: Optional[UUID] = None,
                            outcome: str = S.SUCCESS, metadata: Optional[dict] = None, **actor) -> bool:
    """Queue an audit event in its own transaction, for events with no business transaction to join (a failed sign-in,
    a refused request). Returns False and counts the failure if it could not be stored: the caller's own outcome
    (for instance the 401) is unaffected, and /health/audit shows the gap."""
    if not ENABLED:
        return False
    from database import _session_factory
    try:
        async with _session_factory() as session:
            await record(session, module=module, action=action, entity_type=entity_type, entity_id=entity_id, tenant_id=tenant_id,
                         outcome=outcome, metadata=metadata, **actor)
            await session.commit()
        return True
    except Exception as exc:
        STATS.standalone_failures += 1
        STATS.last_failure = f"{type(exc).__name__}: {exc}"[:300]
        log.exception("could not queue audit event %s", action)
        return False


# ── Request context ─────────────────────────────────────────────────────────────────────────────

_USER_TTL = 300.0
_users: dict[str, tuple[float, dict]] = {}


async def _user_info(user_id: str) -> dict:
    hit = _users.get(user_id)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    from database import _session_factory
    info: dict = {}
    try:
        async with _session_factory() as session:
            row = (await session.execute(text(
                "SELECT u.full_name, u.tenant_id, r.name FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = :id"),
                {"id": user_id})).first()
        if row:
            info = {"name": row[0], "tenant_id": row[1], "role": row[2]}
    except Exception:
        log.warning("audit context: could not look up user %s", user_id)
        return {}
    _users[user_id] = (time.monotonic() + _USER_TTL, info)
    if len(_users) > 5000:
        now = time.monotonic()
        for key in [k for k, (exp, _) in _users.items() if exp < now]:
            _users.pop(key, None)
    return info


class AuditContextMiddleware:
    """Pure ASGI middleware: sets the AuditContext (actor, role, tenant, correlation id) for the request."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not ENABLED:
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        ctx = await self._context(scope, headers)
        token = set_context(ctx)
        try:
            await self.app(scope, receive, send)
        finally:
            reset_context(token)

    async def _context(self, scope, headers: dict) -> AuditContext:
        correlation = headers.get("x-correlation-id") or headers.get("x-request-id")
        if not correlation or not re.fullmatch(r"[A-Za-z0-9._-]{8,64}", correlation):
            correlation = None
        forwarded = headers.get("x-forwarded-for", "").split(",")[0].strip()
        client = scope.get("client")
        base = dict(correlation_id=correlation, client_ip=forwarded or (client[0] if client else None), request_path=scope.get("path"))
        auth = headers.get("authorization", "")
        if not auth.lower().startswith("bearer "):
            return AuditContext(**base)
        try:
            from routers.auth import decode_access_token
            claims = decode_access_token(auth[7:].strip())
        except Exception:
            return AuditContext(**base)
        user_id = str(claims.get("sub") or "")
        if not _uuid(user_id):
            return AuditContext(**base)
        info = await _user_info(user_id)
        return AuditContext(actor_id=user_id, actor_type="USER", actor_role=info.get("role"), actor_name=info.get("name"),
                            tenant_id=_uuid(info.get("tenant_id") or claims.get("tenant_id")), **base)


# ── Delivery ────────────────────────────────────────────────────────────────────────────────────

class _ProducerPublisher:
    """Publishes through the service's existing AIOKafkaProducer."""

    def __init__(self, producer):
        self.producer = producer

    async def publish(self, key: str, value: str) -> None:
        await self.producer.send_and_wait(S.AUDIT_EVENTS_TOPIC, value=value, key=key)


_relay: Optional[OutboxRelay] = None


def start_audit_relay(stop: asyncio.Event, producer) -> Optional[asyncio.Task]:
    """Run the outbox relay for this process. Returns the task to await at shutdown."""
    global _relay
    if not ENABLED:
        return None
    from contextlib import asynccontextmanager
    from database import engine

    @asynccontextmanager
    async def transaction():
        async with engine.begin() as conn:
            yield conn

    _relay = OutboxRelay(transaction, _ProducerPublisher(producer), name="tenant-service audit")
    return asyncio.create_task(_relay.run(stop), name="audit-outbox-relay")


async def audit_status() -> dict:
    """Undelivered audit intents and capture failures, for GET /health/audit."""
    out: dict = {"enabled": ENABLED, "captured": STATS.captured, "mapping_failures": STATS.mapping_failures,
                 "standalone_failures": STATS.standalone_failures, "last_failure": STATS.last_failure}
    if _relay is not None:
        try:
            out["outbox"] = await _relay.stats()
        except Exception as exc:
            out["outbox"] = {"error": f"{type(exc).__name__}: {exc}"[:200]}
    return out
