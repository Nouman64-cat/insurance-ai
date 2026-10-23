"""Explicit authorization callbacks for reviewed financial replay endpoints."""
from types import SimpleNamespace

from fastapi import HTTPException
from routers.auth import _get_current_user, _role_name


async def tenant_identity(values, request):
    token = values.get('token')
    if not token:
        auth = request.headers.get('authorization', '')
        scheme, _, token = auth.partition(' ')
        if scheme.lower() != 'bearer' or not token:
            raise HTTPException(401, 'Authentication required')
    session = values['session']
    user = await _get_current_user(token, session)
    role = await _role_name(user, session)
    if not user.is_active or str(getattr(user.status, 'value', user.status)) != 'ACTIVE':
        raise HTTPException(403, 'Account is inactive')
    if role != 'SuperAdmin' and user.tenant_id != values['tenant_id']:
        raise HTTPException(403, 'Tenant access denied')
    return user, token


async def premium_identity(values, request):
    user, token = await tenant_identity(values, request)
    from routers.policies import _policy_in_scope
    from routers.initial_premium_payment import _get_case, _get_policy
    policy_id = values.get('policy_id')
    if policy_id is None:
        case = await _get_case(values['session'], values['tenant_id'], values['case_id'])
        policy_id = case.policy_id
    if policy_id:
        await _get_policy(values['session'], values['tenant_id'], policy_id)
        await _policy_in_scope(policy_id, token, values['session'])
    return user


async def payout_identity(values, request):
    user, token = await tenant_identity(values, request)
    from routers.claims import _assert_role, ca
    await _assert_role(token, values['session'], ca.DISBURSE_ROLES, 'Executing a claim payment')
    from shared.models.core import Claim
    claim = await values['session'].get(Claim, values['claim_id'])
    if claim is None or claim.tenant_id != values['tenant_id']:
        raise HTTPException(404, 'Claim not found')
    return user


# ── billing responses ─────────────────────────────────────────────────────────────────────────────────────────────────────
# Collection endpoints return the policy's billing view. The receipt keeps only the policy id; an authorized replay rebuilds the
# view from the ledger, so it reflects the original financial outcome (the installments are paid) without storing it twice.
BILLING_FIELDS = ("policy_id", "policy_status", "can_collect", "autopay_enabled", "surcharge_pct", "commission_pct",
                  "installments", "summary", "dashboard")


def billing_receipt(payload):
    return {"policy_id": payload["policy_id"]}


async def replay_billing(values, receipt):
    from routers.policies import _get_policy
    from services.billing_gate import compute_billing
    if receipt["policy_id"] != str(values["policy_id"]):
        raise HTTPException(409, "Billing receipt does not match the policy")
    policy = await _get_policy(values["session"], values["tenant_id"], values["policy_id"])
    return await compute_billing(values["session"], policy)


# ── case workflows (renewal, reinstatement, exit) ─────────────────────────────────────────────────────────────────────────────
def workflow_operation(operation, overview, *, ids=("policy_id", "case_id"), status_code=200, atomic=True, recover="reconcile"):
    """Idempotency for a case-workflow step whose response is the workflow overview.

    Only the identifiers already in the URL are stored; an authorized replay rebuilds the overview from the domain records, so the
    response is current and no customer data is copied into the receipt.

    atomic=True  (default) database-only step: business writes and the receipt commit in ONE transaction.
    atomic=False the step also e-mails or calls another service, which no transaction can undo: the reservation is durable first and
                 `recover` says what an abandoned attempt means ('retry' for a notification, 'reconcile' otherwise).
    """
    async def replay(values, receipt):
        from routers.policies import _get_policy
        if any(receipt.get(k) != str(values[k]) for k in ids):
            raise HTTPException(409, "Idempotency receipt does not match this resource")
        policy = await _get_policy(values["session"], values["tenant_id"], values["policy_id"])
        return await overview(values["session"], policy)

    def receipt_of(values):
        return {k: str(values[k]) for k in ids}

    if atomic:
        from shared.idempotency.http import database_operation
        return database_operation(operation, response_fields=None, status_code=status_code, resource_type="policy", authorize=premium_identity,
                                  receipt_fields=ids, replay_response=replay, view_receipt=receipt_of)
    from shared.idempotency.http import side_effect_operation
    return side_effect_operation(operation, response_fields=None, status_code=status_code, resource_type="policy", authorize=premium_identity,
                                 recover=recover, receipt_fields=ids, replay_response=replay, view_receipt=receipt_of)


def mask_email(address):
    local, _, domain = str(address or "").partition("@")
    return f"{local[:1]}***@{domain}" if domain else "***"


def mask_contact(value):
    """An e-mail address or phone number reduced to something a receipt may hold."""
    value = str(value or "")
    if "@" in value:
        return mask_email(value)
    digits = "".join(ch for ch in value if ch.isdigit())
    return f"***{digits[-3:]}" if len(digits) >= 4 else ("***" if value else value)


def outcome_operation(operation, fields, keep, rebuild, *, recover="retry", resource_type="policy"):
    """Idempotency for a policy action that notifies someone (or calls another service) and answers with its outcome plus a current view.

    `keep(payload)` returns exactly `fields` -- the non-personal outcome worth remembering (masked recipient, timestamp); `rebuild(values, kept)`
    produces the full response on an authorized replay, re-reading the view from the records. recover='retry' means an abandoned attempt
    may be repeated (at-least-once, for notifications); use 'reconcile' where repeating is not acceptable."""
    from shared.idempotency.http import side_effect_operation
    return side_effect_operation(
        operation, response_fields=None, authorize=premium_identity, recover=recover, resource_type=resource_type,
        receipt_fields=("policy_id", *fields),
        view_receipt=lambda values, payload: {"policy_id": str(values["policy_id"]), **(keep(payload) if payload else {k: None for k in fields})},
        replay_response=lambda values, receipt: rebuild(values, {k: receipt[k] for k in fields}))


def billing_operation(operation):
    """Atomic idempotency for a premium-ledger action whose response is the policy's billing view."""
    from shared.idempotency.http import database_operation
    return database_operation(operation, response_fields=BILLING_FIELDS, receipt_fields=("policy_id",), receipt_builder=billing_receipt,
                              replay_response=replay_billing, resource_type="policy", authorize=premium_identity)


def notification_operation(operation, response_fields=("sent_to", "sent_at", "delivered")):
    """E-mail/letter sends: a completed send is never repeated for the same operation; an abandoned one may be re-sent (at-least-once).
    The receipt keeps a masked recipient, never the address."""
    from shared.idempotency.http import side_effect_operation

    def store(receipt):
        return {**receipt, "sent_to": mask_email(receipt["sent_to"])} if "sent_to" in receipt else receipt
    return side_effect_operation(operation, response_fields=response_fields, authorize=premium_identity, recover="retry",
                                 resource_type="policy", store=store)


# ── customer-portal internal calls ──────────────────────────────────────────────────────────────────────────────────────────
async def portal_identity(values, request):
    """Customer Management signs these calls; the router-level signature dependency has already authenticated the caller for THIS
    request (replays included). The actor is the portal customer named in the path, so a key reused for another customer conflicts."""
    return SimpleNamespace(id=f"portal:{values['customer_id']}")


async def tenant_user_identity(values, request):
    """The signed-in user, for endpoints guarded by a router-level admin check rather than a `user` parameter."""
    user, _token = await tenant_identity(values, request)
    return user


def read_model_operation(operation, read_model, loader, *, status_code=200, resource_type=None, id_field="id", render=None):
    """Atomic idempotency for an endpoint whose response is one record rendered through a read model (the route's `response_model`).

    The receipt holds the record id; an authorized replay reloads the record and renders it with the same read model, so the body is
    exactly what the route would have returned and nothing beyond the model's fields is ever exposed or stored.

    `loader(values)` finds the record from the request (path ids); a creating endpoint passes `loader(values, record_id)` instead, because
    the record did not exist before the call. `id_field` names the read model's identifier (cases use `caseld`).
    `render(values, record)` builds the read model when it needs more than the record's own columns (counts, joined names).
    """
    import inspect
    from shared.idempotency.http import database_operation
    takes_id = len(inspect.signature(loader).parameters) >= 2

    async def replay(values, receipt):
        record = await (loader(values, receipt["id"]) if takes_id else loader(values))
        if record is None or str(getattr(record, id_field)) != receipt["id"]:
            raise HTTPException(409, "Idempotency receipt does not match this resource")
        return await render(values, record) if render is not None else read_model.model_validate(record, from_attributes=True)

    return database_operation(operation, response_fields=tuple(read_model.model_fields), status_code=status_code, resource_type=resource_type,
                              authorize=tenant_user_identity, receipt_fields=("id",), receipt_builder=lambda payload: {"id": str(payload[id_field])},
                              replay_response=replay, serialize=lambda record: read_model.model_validate(record, from_attributes=True))


def tenant_operation(operation, response_fields, *, status_code=200, resource_type=None):
    """Atomic idempotency for a tenant-scoped, database-only endpoint whose response is a small dict with no personal data.
    The signed-in user is taken from the bearer token (the endpoint itself may rely on a router-level check)."""
    from shared.idempotency.http import database_operation
    return database_operation(operation, response_fields=tuple(response_fields), status_code=status_code, resource_type=resource_type,
                              authorize=tenant_user_identity)


def sanitized_operation(operation, response_fields, *, drop, rebuild, receipt_ids=(), status_code=200, resource_type=None):
    """Atomic idempotency where the response is mostly identifiers but one field carries personal data (for example nominees).

    The receipt stores every reviewed field EXCEPT those in `drop`; an authorized replay merges `await rebuild(values)` (a dict of the
    dropped fields, rebuilt from the records) back into the stored receipt."""
    from shared.idempotency.http import database_operation
    keep = tuple(f for f in response_fields if f not in drop)

    async def replay(values, receipt):
        return {**receipt, **(await rebuild(values))}

    return database_operation(operation, response_fields=tuple(response_fields), status_code=status_code, resource_type=resource_type,
                              authorize=tenant_user_identity, receipt_fields=keep,
                              receipt_builder=lambda payload: {k: payload[k] for k in keep}, replay_response=replay)


async def scoped_identity(values, request):
    """Authorization for a replayed call: the signed-in user of this tenant, and, when the route names a policy or a case, that
    record's scope (an agent may only act on their own book). Routes with neither (for example `/requirements/{id}`) rely on the
    tenant check, because the receipt itself is tenant-scoped."""
    if values.get("policy_id") is not None or values.get("case_id") is not None:
        return await premium_identity(values, request)
    return await tenant_user_identity(values, request)


def records_operation(operation, model, builder, *, many=False, status_code=200, resource_type=None, render=None, ids_of=None):
    """Atomic idempotency for an endpoint that returns hand-built dicts of the records it created or changed.

    The receipt keeps only the record ids; an authorized replay reloads the rows and rebuilds the response with the endpoint's own
    `builder(row)` (or `render(values, rows)` when the response wraps them; `ids_of(values, payload)` overrides which ids are kept), so nothing is copied into the receipt and the replay
    shows the records as they are now."""
    import inspect
    from uuid import UUID
    from shared.idempotency.http import database_operation

    def receipt_of(values, payload):
        if ids_of is not None:
            return {"ids": [str(i) for i in ids_of(values, payload)]}
        return {"ids": [str(item["id"]) for item in (payload if many else [payload])]}

    async def replay(values, receipt):
        rows = [await values["session"].get(model, UUID(i)) for i in receipt["ids"]]
        if any(row is None for row in rows):
            raise HTTPException(409, "Idempotency receipt does not match this resource")
        if render is not None:
            return await render(values, rows)
        out = []
        for row in rows:
            built = builder(row)
            out.append(await built if inspect.isawaitable(built) else built)
        return out if many else out[0]

    return database_operation(operation, response_fields=None, status_code=status_code, resource_type=resource_type, authorize=scoped_identity,
                              receipt_fields=("ids",), replay_response=replay, view_receipt=receipt_of)


def reviewed_operation(operation, spec, *, status_code=200, resource_type=None, authorize=None, atomic=True, recover="retry"):
    """Idempotency for an endpoint whose whole response is a reviewed, non-personal structure (a status dict, a list of small dicts).

    `spec` is the schema accepted by `shared.idempotency.http.schema_ok`; a response outside it is refused at store time, so a field
    added later cannot start leaking into receipts unreviewed. atomic=False is for a step that also publishes an event, e-mails or calls
    another service (a flat field list only): the reservation is durable first and `recover` decides what an abandoned attempt means."""
    authorize = authorize or scoped_identity
    if atomic:
        from shared.idempotency.http import database_operation
        return database_operation(operation, response_fields=spec, status_code=status_code, resource_type=resource_type, authorize=authorize)
    from shared.idempotency.http import side_effect_operation
    return side_effect_operation(operation, response_fields=tuple(spec), status_code=status_code, resource_type=resource_type,
                                 authorize=authorize, recover=recover)


def step_operation(operation, rebuild, *, ids, fields=(), keep=None, atomic=True, recover="retry", status_code=200, resource_type=None, authorize=None):
    """Idempotency for one step of a case/policy workflow whose response can be rebuilt from the records.

    The receipt holds only the identifiers named in `ids` (taken from the request) plus, optionally, `fields` -- small non-personal
    outcome values `keep(payload)` extracts from the first response. An authorized replay calls `rebuild(values)` (or
    `rebuild(values, kept)` when there are `fields`) and returns the current view, so no personal data is stored.

    atomic=True   database-only step: business writes and the receipt commit together.
    atomic=False  the step also publishes an event, e-mails or calls another service. The reservation is durable first; `recover`
                  says what an abandoned attempt means ('retry': the state machine already refuses a second transition, so repeating
                  is safe; 'reconcile': the owner must decide)."""
    authorize = authorize or scoped_identity
    receipt_fields = (*ids, *fields)

    async def replay(values, receipt):
        if any(receipt.get(k) != str(values[k]) for k in ids):
            raise HTTPException(409, "Idempotency receipt does not match this resource")
        return await (rebuild(values, {k: receipt[k] for k in fields}) if fields else rebuild(values))

    def receipt_of(values, payload=None):
        out = {k: str(values[k]) for k in ids}
        if fields:
            out.update(keep(payload) if payload is not None else {k: None for k in fields})
        return out

    if atomic:
        from shared.idempotency.http import database_operation
        return database_operation(operation, response_fields=None, status_code=status_code, resource_type=resource_type, authorize=authorize,
                                  receipt_fields=receipt_fields, replay_response=replay, view_receipt=receipt_of)
    from shared.idempotency.http import side_effect_operation
    return side_effect_operation(operation, response_fields=None, status_code=status_code, resource_type=resource_type, authorize=authorize,
                                 recover=recover, receipt_fields=receipt_fields, replay_response=replay, view_receipt=receipt_of)


def secret_link_operation(operation, response_fields, *, secrets, masked=(), resource_type=None, authorize=None):
    """A step that issues a one-time link or password and sends it. The secret is returned on the first call only: the receipt keeps the
    outcome (when it expires, whether the e-mail went) with the secret fields emptied and recipients masked, so a replay never repeats
    the send and never re-discloses a credential. A retry after an abandoned attempt may send again (the previous link is replaced)."""
    from shared.idempotency.http import side_effect_operation

    def scrub(value):
        if isinstance(value, dict):
            return {k: (None if k in secrets else mask_contact(v) if k in masked else scrub(v)) for k, v in value.items()}
        if isinstance(value, list):
            return [scrub(v) for v in value]
        return value
    store = scrub
    return side_effect_operation(operation, response_fields=tuple(response_fields), authorize=authorize or scoped_identity, recover="retry",
                                 resource_type=resource_type, store=store)


def token_operation(operation, resolve, rebuild, *, token_arg="token", recover="retry", status_code=200, resource_type=None, fields=(), keep=None):
    """Idempotency for a PUBLIC endpoint whose only credential is a link token (no tenant in the URL, no signed-in user).

    The scope is a digest of the token, so the same key under another link is a different operation and the token itself is never stored.
    `resolve(values)` is the endpoint's own link check (404/410 for an unknown or expired link) and runs again on every replay;
    `rebuild(values)` -- or `rebuild(values, kept)` when `fields` are declared -- answers a replay from the current records.
    `keep(payload)` returns exactly `fields`: small non-personal facts of the first answer (ids of what was created).
    recover='retry': the endpoint's own state rules already refuse a repeat."""
    import hashlib
    from shared.idempotency.http import side_effect_operation

    def digest(values):
        return hashlib.sha256(str(values[token_arg]).encode()).hexdigest()

    async def authorize(values, request):
        await resolve(values)
        return SimpleNamespace(id=f"link:{digest(values)[:32]}")

    def receipt_of(values, payload=None):
        out = {"link": digest(values)[:16]}
        if fields:
            out.update(keep(payload) if payload is not None else {k: None for k in fields})
        return out

    async def replay(values, receipt):
        return await (rebuild(values, {k: receipt[k] for k in fields}) if fields else rebuild(values))

    return side_effect_operation(
        operation, response_fields=None, authorize=authorize, scope=lambda values: f"link:{digest(values)[:32]}", recover=recover,
        status_code=status_code, resource_type=resource_type, receipt_fields=("link", *fields),
        view_receipt=receipt_of, replay_response=replay)
