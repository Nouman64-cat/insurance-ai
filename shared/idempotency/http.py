"""Opt-in FastAPI adapter for reviewed, database-only endpoints.

Dependencies (especially authorization) execute before this wrapper on EVERY call.
Do not apply to handlers with network calls, file writes, background tasks, streaming
responses or inline authorization which must be evaluated again on replay.
"""
import inspect
import os
from functools import wraps
from typing import get_type_hints

from fastapi import HTTPException, Request
from fastapi.encoders import jsonable_encoder
from starlette.responses import JSONResponse
from .core import IdempotencyError, complete, fingerprint, reserve, validate_key


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
                       receipt_fields=None, replay_response=None, receipt_builder=None):
    """Atomic business+outbox+receipt commit, including handlers that call commit().

    A dedicated outer transaction owns the actual commit. The endpoint session
    uses savepoints so existing commits cannot escape that transaction. The safe
    response schema is an explicit allowlist, not a heuristic PII scrubber.
    Authentication MUST already be a dependency returning `user`; its tenant and
    role permissions must be rechecked for every HTTP call.
    """
    if (receipt_fields is None) != (replay_response is None):
        raise ValueError('Resource replay requires both receipt_fields and replay_response')
    if receipt_builder is not None and receipt_fields is None:
        raise ValueError('A receipt builder requires an explicit safe receipt schema')
    if receipt_builder is None and receipt_fields is not None and not set(receipt_fields) <= set(response_fields):
        raise ValueError('Receipt fields must belong to the reviewed response schema')
    def decorate(fn):
        sig = inspect.signature(fn)
        hints = get_type_hints(fn)
        params = [p.replace(annotation=hints.get(p.name, p.annotation)) for p in sig.parameters.values()]
        injected = 'idempotency_request' not in sig.parameters
        if injected:
            params.append(inspect.Parameter('idempotency_request', inspect.Parameter.KEYWORD_ONLY, annotation=Request))
        @wraps(fn)
        async def wrapped(*args, **kwargs):
            request = kwargs.pop('idempotency_request', None) if injected else kwargs.get('idempotency_request')
            # Direct Python callers are not HTTP clients. They retain existing
            # business uniqueness guarantees; HTTP adapters always receive Request.
            if request is None:
                return await fn(*args, **kwargs)
            try:
                values = sig.bind(*args, **kwargs).arguments
                session, tenant = values['session'], values['tenant_id']
                user = await authorize(values, request) if authorize else values['user']
                key = key_from_request(request, operation)
                if key is None:
                    return await fn(*args, **kwargs)
                body = {k: jsonable_encoder(v) for k, v in values.items()
                        if k not in {'session', 'user', 'request', 'idempotency_request', 'token'} }
                body['query'] = sorted(request.query_params.multi_items())
                body['path'] = request.path_params
                engine = session.bind
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
                            result = await fn(**call)
                            await owned.commit()
                            payload = jsonable_encoder(result)
                            if not isinstance(payload, dict) or set(payload) - set(response_fields):
                                raise RuntimeError(f'Unreviewed replay response schema for {operation}')
                            if receipt_builder is not None:
                                receipt = jsonable_encoder(receipt_builder(payload))
                                if not isinstance(receipt, dict) or set(receipt) != set(receipt_fields):
                                    raise RuntimeError(f'Unreviewed receipt schema for {operation}')
                            else:
                                receipt = payload if receipt_fields is None else {k: payload[k] for k in receipt_fields}
                            await complete(conn, reservation, http_status=status_code, response=receipt,
                                resource_type=resource_type, resource_id=payload.get('id'))
                        return JSONResponse(payload, status_code=status_code)
            except IdempotencyError as exc:
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
