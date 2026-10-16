"""Track reviewers can write only their own underwriting review, not wider operations."""
import re
from fastapi import HTTPException
from fastapi.responses import JSONResponse
import database
from routers.auth import _get_current_user, _role_name

async def restrict_specialist_writes(request, call_next):
    if request.method not in {'POST', 'PUT', 'PATCH', 'DELETE'} or not request.url.path.startswith('/tenants/'):
        return await call_next(request)
    authorization = request.headers.get('authorization', '')
    if not authorization.lower().startswith('bearer '):
        return await call_next(request)
    try:
        async with database._session_factory() as session:
            user = await _get_current_user(authorization[7:], session)
            role = await _role_name(user, session)
    except HTTPException as exc:
        return JSONResponse(status_code=exc.status_code, content={'detail': exc.detail})
    if role in {'Medical Underwriter', 'Financial Underwriter'}:
        track = 'medical' if role == 'Medical Underwriter' else 'financial'
        permitted = request.method == 'PUT' and re.fullmatch(r'/tenants/[^/]+/cases/[^/]+/underwriting-tracks/' + track + r'/?', request.url.path)
        if not permitted:
            return JSONResponse(status_code=403, content={'detail': 'This role can update only its own underwriting review. Final approval, gates and policy operations require an authorized general underwriter or admin.'})
    return await call_next(request)
