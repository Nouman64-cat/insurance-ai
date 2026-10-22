"""Opt-in FastAPI adapter for reviewed, database-only endpoints.

Dependencies (especially authorization) execute before this wrapper on EVERY call.
Do not apply to handlers with network calls, file writes, background tasks, streaming
responses or inline authorization which must be evaluated again on replay.
"""
import hashlib
import inspect
import logging
import os
from functools import wraps
from typing import get_type_hints

from fastapi import HTTPException, Request
from fastapi.encoders import jsonable_encoder
from starlette.datastructures import UploadFile
from starlette.responses import JSONResponse, Response
from sqlalchemy import select
from .core import IdempotencyError, complete, fail, fingerprint, reconcile, reserve, validate_key
from .models import idempotency_records as _records


log = logging.getLogger('idempotency.http')


def _view_receipt(fn, values, payload):
    """A view receipt is built from the request values, and may also read the response when the call creates the resource."""
    return fn(values, payload) if len(inspect.signature(fn).parameters) >= 2 else fn(values)


async def _encodable(value):
    """A request value as JSON for fingerprinting. An uploaded file is represented by its name, type, size and SHA-256, so the same file
    sent twice is the same request and a different file under the same key conflicts; the stream is rewound for the handler."""
    if isinstance(value, UploadFile):
        digest, size = hashlib.sha256(), 0
        await value.seek(0)
        while chunk := await value.read(1 << 20):
            digest.update(chunk)
            size += len(chunk)
        await value.seek(0)
        return {'filename': value.filename, 'content_type': value.content_type, 'size': size, 'sha256': digest.hexdigest()}
    if isinstance(value, (list, tuple)):
        return [await _encodable(v) for v in value]
    return jsonable_encoder(value)


async def _fingerprint_body(values, request, skip):
    body = {k: await _encodable(v) for k, v in values.items() if k not in skip}
    body['query'] = sorted(request.query_params.multi_items())
    body['path'] = request.path_params
    return body


def schema_ok(payload, spec):
    """Is `payload` within the reviewed response schema `spec`?

    spec = ('a', 'b')            a dict whose keys are a subset of the names (values unchecked, as before);
    spec = {'a': spec, ...}      a dict whose keys are listed; a nested dict/list value follows its own sub-spec, other keys are leaves;
    spec = [spec]                a list whose every item follows the sub-spec.
    A schema names what may be stored; it is never inferred, so a new response field is refused until someone reviews it."""
    if isinstance(spec, list):
        return isinstance(payload, list) and all(schema_ok(item, spec[0]) for item in payload)
    if not isinstance(payload, dict):
        return False
    if isinstance(spec, dict):
        return set(payload) <= set(spec) and all(spec[k] is None or payload[k] is None or schema_ok(payload[k], spec[k]) for k in payload)
    return set(payload) <= set(spec)


def key_from_request(request, operation):
    values = request.headers.getlist('idempotency-key')
    if len(values) > 1:
        raise IdempotencyError('IDEMPOTENCY_KEY_INVALID', 400)
    key = values[0] if values else None
    mode = os.getenv('IDEMPOTENCY_ENFORCEMENT', 'optional')
    if mode not in ('optional', 'required'):
        raise RuntimeError('IDEMPOTENCY_ENFORCEMENT must be optional or required')
    if key is None:
        if mode == 'required':
            raise IdempotencyError('IDEMPOTENCY_KEY_REQUIRED', 400)
        return None
    return validate_key(key)


def database_operation(operation, *, response_fields, status_code=200, resource_type=None, authorize=None,
                       receipt_fields=None, replay_response=None, receipt_builder=None, view_receipt=None, serialize=None):
    """Atomic business+outbox+receipt commit, including handlers that call commit().

    A dedicated outer transaction owns the actual commit. The endpoint session
    uses savepoints so existing commits cannot escape that transaction. The safe
    response schema is an explicit allowlist, not a heuristic PII scrubber.
    Authentication MUST already be a dependency returning `user`; its tenant and
    role permissions must be rechecked for every HTTP call.
    """
    if view_receipt is not None:
        # View mode: the response is a large derived view. Only identifiers from the request are stored; an authorized replay rebuilds
        # the view from the domain records. No response schema is stored, so none is allowlisted.
        if response_fields is not None or replay_response is None or receipt_fields is None or receipt_builder is not None:
            raise ValueError('View receipts need response_fields=None, receipt_fields, replay_response and no receipt_builder')
    elif response_fields is None:
        raise ValueError('response_fields is required unless a view receipt is used')
    if (receipt_fields is None) != (replay_response is None):
        raise ValueError('Resource replay requires both receipt_fields and replay_response')
    if receipt_builder is not None and receipt_fields is None:
        raise ValueError('A receipt builder requires an explicit safe receipt schema')
    if view_receipt is None and receipt_builder is None and receipt_fields is not None and not (isinstance(response_fields, (tuple, set, frozenset)) and set(receipt_fields) <= set(response_fields)):
        raise ValueError('Receipt fields must belong to the reviewed response schema')
    def decorate(fn):
        sig = inspect.signature(fn)
        hints = get_type_hints(fn)
        params = [p.replace(annotation=hints.get(p.name, p.annotation)) for p in sig.parameters.values()]
        request_name = next((p.name for p in params if p.annotation is Request), None)
        injected = request_name is None
        if injected:
            request_name = 'idempotency_request'
            params.append(inspect.Parameter('idempotency_request', inspect.Parameter.KEYWORD_ONLY, annotation=Request))
        @wraps(fn)
        async def wrapped(*args, **kwargs):
            request = kwargs.pop(request_name, None) if injected else kwargs.get(request_name)
            # Direct Python callers (jobs, other handlers, tests passing a stand-in) are not HTTP clients. They retain the existing
            # business uniqueness guarantees; only a real HTTP request carries an operation key.
            if not isinstance(request, Request):
                return await fn(*args, **kwargs)
            try:
                values = sig.bind(*args, **kwargs).arguments
                session, tenant = values['session'], values.get('tenant_id')
                # No key: the request takes the handler's original path untouched (no extra lookups); keyed requests are authorized first.
                key = key_from_request(request, operation)
                if key is None:
                    return await fn(*args, **kwargs)
                user = await authorize(values, request) if authorize else next(
                    (values[n] for n in ('user', 'current_user', '_user') if n in values), None)
                if user is None:
                    raise RuntimeError(f'{operation}: no authenticated actor available; pass authorize=')
                body = await _fingerprint_body(values, request, {'session', 'user', 'current_user', '_user', 'request', 'idempotency_request', 'token', request_name})
                engine = session.bind
                rejected = None
                async with engine.connect() as conn:
                    async with conn.begin():
                        reservation = await reserve(conn, scope_id=f'tenant:{tenant}', operation=operation,
                            key=key, request_hash=fingerprint(body, actor_id=user.id),
                            retention_days=int(os.getenv('IDEMPOTENCY_RETENTION_DAYS', '30')))
                        if reservation.replay:
                            payload = reservation.response
                            if replay_response is not None:
                                payload = jsonable_encoder(await replay_response(values, payload))
                            return JSONResponse(payload, status_code=reservation.http_status,
                                                headers={'Idempotency-Replayed': 'true'})
                        async with type(session)(bind=conn, expire_on_commit=False,
                                                 join_transaction_mode='create_savepoint') as owned:
                            call = dict(values, session=owned)
                            # ORM actor remains read-only in the dependency session.
                            try:
                                result = await fn(**call)
                            except HTTPException as exc:
                                if exc.status_code >= 500:
                                    raise           # a server-side failure: everything, receipt included, rolls back as one unit
                                # A rejected request (4xx). Work the handler already committed (released savepoints, e.g. a recorded
                                # failed-payment attempt) is kept exactly as without this adapter; anything uncommitted is
                                # discarded when the owned session closes. The FAILED marker is written AFTER that close, or the
                                # session's savepoint rollback would undo it. The key stays retryable: nothing was completed.
                                rejected = exc
                            if rejected is None:
                                await owned.commit()
                                payload = jsonable_encoder(serialize(result) if serialize is not None else result)
                                if view_receipt is None and not schema_ok(payload, response_fields):
                                    raise RuntimeError(f'Unreviewed replay response schema for {operation}')
                                if view_receipt is not None:
                                    receipt = jsonable_encoder(_view_receipt(view_receipt, values, payload))
                                    if not isinstance(receipt, dict) or set(receipt) != set(receipt_fields):
                                        raise RuntimeError(f'Unreviewed receipt schema for {operation}')
                                elif receipt_builder is not None:
                                    receipt = jsonable_encoder(receipt_builder(payload))
                                    if not isinstance(receipt, dict) or set(receipt) != set(receipt_fields):
                                        raise RuntimeError(f'Unreviewed receipt schema for {operation}')
                                else:
                                    receipt = payload if receipt_fields is None else {k: payload[k] for k in receipt_fields}
                                await complete(conn, reservation, http_status=status_code, response=receipt, resource_type=resource_type,
                                    resource_id=payload.get('id') if isinstance(payload, dict) else None)
                                response = JSONResponse(payload, status_code=status_code)
                        if rejected is not None:
                            await fail(conn, reservation, uncertain=False, error_code=f'HTTP_{rejected.status_code}')
                # The outer transaction has committed (handler-committed work and the FAILED marker included).
                if rejected is not None:
                    raise rejected
                return response
            except IdempotencyError as exc:
                log.info('idempotency_refused operation=%s code=%s status=%s', operation, exc.code, exc.status)
                raise HTTPException(exc.status, {'code': exc.code},
                    headers={'Retry-After': str(exc.retry_after)} if exc.retry_after else None) from exc
        wrapped.__signature__ = sig.replace(parameters=params, return_annotation=hints.get('return', sig.return_annotation))
        wrapped.idempotency_operation = operation
        return wrapped
    return decorate


def required_uuid_header(request):
    """Header-only identity for legacy domain tables whose key column is UUID.

    UUID keys preserve their original value. Other validated operation IDs map
    deterministically into a fixed UUID namespace; no request content is used.
    """
    from uuid import UUID, uuid5, NAMESPACE_URL
    try:
        values = request.headers.getlist('idempotency-key')
        if len(values) != 1:
            raise IdempotencyError('IDEMPOTENCY_KEY_REQUIRED' if not values else 'IDEMPOTENCY_KEY_INVALID', 400)
        key = validate_key(values[0])
        try:
            return UUID(key)
        except ValueError:
            return uuid5(NAMESPACE_URL, 'getinsuredai:header:' + key)
    except IdempotencyError as exc:
        raise HTTPException(400, {'code': exc.code}) from exc


def side_effect_operation(operation, *, response_fields, status_code=200, resource_type=None, authorize=None,
                          recover='reconcile', lease_seconds=300, scope=None, store=None, view_receipt=None, replay_response=None, receipt_fields=None, serialize=None, evidence=None):
    """Operation identity for handlers that do work no database transaction can roll back: e-mail, file or document output,
    calls to another service. Use `database_operation` for anything that is purely database work.

    Sequence: (1) the reservation commits first; (2) the handler runs unchanged, with its own session and commits; (3) a short transaction
    stores the approved response. A retry with the same key after completion replays it, a concurrent one is told to wait.

    `recover` decides what an abandoned attempt (a crash, a cancelled request, a lease that ran out) means for the NEXT retry:
      * 'reconcile' (default) -- the work may have happened, so the retry is refused with IDEMPOTENCY_RECONCILIATION_REQUIRED until the
        owner decides. Use for anything that moves money or changes a record someone else relies on.
      * 'retry' -- the work is a notification; repeating it is acceptable, so the retry is allowed to run again (at-least-once).
    A handler that rejects the request (HTTPException) leaves the key FAILED and retryable; any other exception is treated as unknown
    unless recover='retry'. Authentication/authorization is repeated on every call, including replays.

    `store(payload) -> dict` may minimise what is kept (for example mask a recipient); by default only `response_fields` are stored.

    `evidence(values, record) -> True | False | None` lets an abandoned attempt settle itself from the domain records: True = the work
    demonstrably happened since this reservation (complete it; view receipts only), False = it demonstrably did not (retry), None = cannot
    tell (stay in reconciliation). Use it where the business state is authoritative, e.g. "this premium is now realized".
    """
    if recover not in ('reconcile', 'retry'):
        raise ValueError("recover must be 'reconcile' or 'retry'")
    if view_receipt is not None and (response_fields is not None or replay_response is None or receipt_fields is None):
        raise ValueError('View receipts need response_fields=None, receipt_fields and replay_response')
    if view_receipt is None and response_fields is None:
        raise ValueError('response_fields is required unless a view receipt is used')
    allowed = tuple(response_fields or ())

    def decorate(fn):
        sig = inspect.signature(fn)
        hints = get_type_hints(fn)
        params = [p.replace(annotation=hints.get(p.name, p.annotation)) for p in sig.parameters.values()]
        request_name = next((p.name for p in params if p.annotation is Request), None)
        injected = request_name is None
        if injected:
            request_name = 'idempotency_request'
            params.append(inspect.Parameter('idempotency_request', inspect.Parameter.KEYWORD_ONLY, annotation=Request))

        @wraps(fn)
        async def wrapped(*args, **kwargs):
            request = kwargs.pop(request_name, None) if injected else kwargs.get(request_name)
            if not isinstance(request, Request):     # a direct Python call, not an HTTP client
                return await fn(*args, **kwargs)
            try:
                values = sig.bind(*args, **kwargs).arguments
                session, tenant = values['session'], values.get('tenant_id')
                # No key: the request takes the handler's original path untouched (no extra lookups); keyed requests are authorized first.
                key = key_from_request(request, operation)
                if key is None:
                    return await fn(*args, **kwargs)
                user = await authorize(values, request) if authorize else next(
                    (values[n] for n in ('user', 'current_user', '_user') if n in values), None)
                if user is None:
                    raise RuntimeError(f'{operation}: no authenticated actor available; pass authorize=')
                body = await _fingerprint_body(values, request, {'session', 'user', 'current_user', '_user', 'request', 'idempotency_request', 'token', request_name})
                if scope is None and tenant is None:
                    raise RuntimeError(f'{operation}: a route without tenant_id needs an explicit scope=')
                scope_id = scope(values) if scope else f'tenant:{tenant}'
                request_hash = fingerprint(body, actor_id=user.id)
                retention = int(os.getenv('IDEMPOTENCY_RETENTION_DAYS', '30'))
                engine = session.bind

                async def reserve_now():
                    async with engine.begin() as conn:
                        return await reserve(conn, scope_id=scope_id, operation=operation, key=key, request_hash=request_hash,
                                             retention_days=retention, lease_seconds=lease_seconds)
                try:
                    reservation = await reserve_now()
                except IdempotencyError as exc:
                    if exc.code != 'IDEMPOTENCY_RECONCILIATION_REQUIRED' or (recover != 'retry' and evidence is None):
                        raise
                    async with engine.begin() as conn:
                        row = (await conn.execute(select(_records).where(_records.c.scope_id == scope_id,
                            _records.c.operation == operation, _records.c.idempotency_key == key).with_for_update())).mappings().one()
                    verdict = await evidence(values, row) if evidence is not None else (False if recover == 'retry' else None)
                    if verdict is None:
                        raise
                    async with engine.begin() as conn:
                        if verdict:
                            if view_receipt is None:
                                raise
                            done = jsonable_encoder(_view_receipt(view_receipt, values, None))
                            await reconcile(conn, row['id'], expected_token=row['lease_token'], response=done, http_status=status_code)
                        else:    # nothing happened (or only a repeatable notification did): settle the attempt and run it again
                            await reconcile(conn, row['id'], expected_token=row['lease_token'], definitely_not_executed=True)
                    if verdict:
                        return JSONResponse(jsonable_encoder(await replay_response(values, done)), status_code=status_code,
                                            headers={'Idempotency-Replayed': 'true'})
                    reservation = await reserve_now()
                if reservation.replay:
                    body_out = reservation.response if view_receipt is None else jsonable_encoder(await replay_response(values, reservation.response))
                    return JSONResponse(body_out, status_code=reservation.http_status, headers={'Idempotency-Replayed': 'true'})
                try:
                    result = await fn(*args, **kwargs)
                except HTTPException:
                    async with engine.begin() as conn:
                        await fail(conn, reservation, uncertain=False, error_code='HTTP_REJECTED')
                    raise
                except Exception:
                    async with engine.begin() as conn:
                        await fail(conn, reservation, uncertain=recover != 'retry', error_code='HANDLER_ERROR')
                    raise
                payload = jsonable_encoder(serialize(result) if serialize is not None else result) if not isinstance(result, Response) else None
                if view_receipt is not None:
                    receipt = jsonable_encoder(_view_receipt(view_receipt, values, payload))
                    if not isinstance(receipt, dict) or set(receipt) != set(receipt_fields):
                        log.error('idempotency_bad_view_receipt operation=%s', operation)
                        receipt = {'completed': True}
                elif isinstance(payload, dict):
                    extra = set(payload) - set(allowed)
                    if extra:
                        log.warning('idempotency_unreviewed_fields operation=%s fields=%s', operation, sorted(extra))
                    receipt = {k: payload[k] for k in allowed if k in payload}
                    if store is not None:
                        receipt = store(receipt)
                else:
                    receipt = {'completed': True}
                resource_id = payload.get('id') if isinstance(payload, dict) else None
                async with engine.begin() as conn:
                    try:
                        await complete(conn, reservation, http_status=status_code, response=receipt, resource_type=resource_type, resource_id=resource_id)
                    except ValueError:
                        await complete(conn, reservation, http_status=status_code, response={'completed': True}, resource_type=resource_type)
                return result
            except IdempotencyError as exc:
                log.info('idempotency_refused operation=%s code=%s status=%s', operation, exc.code, exc.status)
                raise HTTPException(exc.status, {'code': exc.code},
                    headers={'Retry-After': str(exc.retry_after)} if exc.retry_after else None) from exc
        wrapped.__signature__ = sig.replace(parameters=params, return_annotation=hints.get('return', sig.return_annotation))
        wrapped.idempotency_operation = operation
        return wrapped
    return decorate
