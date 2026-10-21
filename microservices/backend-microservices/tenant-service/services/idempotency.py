"""Explicit authorization callbacks for reviewed financial replay endpoints."""
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
