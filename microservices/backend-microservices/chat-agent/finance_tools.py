"""Finance-only payment tools using the owning claim settlement workflow."""
from tool_executor import handles, ChoiceNeeded, relay_forbidden


def _finance(ctx):
    if ctx.exec_ctx.role != 'Finance':
        raise PermissionError('Finance role required.')


def _open(claim=None):
    path = f"claims/{claim['id']}" if claim else 'finance'
    return {'label': 'Open payment workspace' if claim else 'Open Finance dashboard', 'actionType': 'navigate', 'payload': path}


async def _read(args, ctx):
    from claim_workflow_tools import _resolve_financial_claim, _base
    if not (args.get('claim_number') or args.get('claimant_name')):
        raise ChoiceNeeded('Which claim payment should I review?', [_open()])
    try:
        claim = await _resolve_financial_claim(args, ctx)
    except ChoiceNeeded as exc:
        raise ChoiceNeeded('Which claim payment should I review?', [
            {'label': choice['label'], 'actionType': 'submit',
             'payload': f"Show payment details for claim {choice['label']}"}
            for choice in exc.quick_actions]) from exc
    res = await ctx.client.get(_base(ctx, str(claim['policy_id']), str(claim['id'])))
    if res.status_code == 409:
        return claim, {'claim': claim, 'settlement': {}, 'can': {}, 'missing_workflow': True}
    res.raise_for_status()
    return claim, res.json()


def _result(claim, ws, message):
    st = ws.get('settlement') or {}
    # Do not pass medical or investigation data, or claims staff's action chips, into Finance planning.
    claim = {**claim, 'status': (ws.get('claim') or {}).get('status', claim.get('status'))}
    return {'success': True, 'claim': {k: claim.get(k) for k in ('id','claim_number','policy_id','policy_number','customer_name','claimant_name','status','approved_amount')},
            'settlement': st, 'can': {k: bool((ws.get('can') or {}).get(k)) for k in ('disburse','reconcile')},
            'message': message, 'quick_actions': [_open(claim)]}


@handles('get_finance_dashboard')
@relay_forbidden
async def dashboard(args, ctx):
    _finance(ctx)
    res = await ctx.client.get(ctx.tsvc('/claims'))
    res.raise_for_status()
    claims = res.json()
    pending = [c for c in claims if c.get('status') in ('Approved','Partial Approval')]
    paid = [c for c in claims if c.get('status') in ('Settled','Closed') and (c.get('settlement_amount') or 0)>0]
    reconcile = [c for c in claims if c.get('status') == 'Settled' and not (c.get('finance_summary') or {}).get('reconciled_at')]
    queue = args.get('queue') or 'payouts'
    if queue not in ('payouts','reconciliation','history'):
        raise ValueError('Choose payouts, reconciliation or history.')
    rows = {'payouts':pending,'reconciliation':reconcile,'history':paid}[queue]
    search = str(args.get('search') or '').strip().casefold()
    if search:
        rows = [c for c in rows if search in ' '.join(str(c.get(k) or '') for k in ('claim_number','policy_number','customer_name','claimant_name')).casefold()]
    fields = ('id','claim_number','policy_id','policy_number','customer_name','claimant_name','status','approved_amount','settlement_amount','finance_summary')
    return {'success':True,'queue':queue,'claims':[{k:c.get(k) for k in fields} for c in rows],
            'totals':{'awaiting_payout':len(pending),'approved_pending':sum(c.get('approved_amount') or 0 for c in pending),
                      'to_reconcile':len(reconcile),'recorded_payments':sum(c.get('settlement_amount') or 0 for c in paid)},
            'message':f'{len(rows)} claims in the {queue} queue. Approval alone does not authorise payout; inspect settlement details first.',
            'quick_actions':[_open()]}


@handles('list_finance_payments')
@relay_forbidden
async def payment_register(args, ctx):
    _finance(ctx)
    params = {k: args[k] for k in ('search', 'payment_status', 'offset', 'limit') if args.get(k) is not None}
    res = await ctx.client.get(ctx.tsvc('/claims/payments'), params=params)
    res.raise_for_status()
    data = res.json()
    rows = data['items']
    # Keep this a payment register, never a clinical or claim-investigation view.
    fields = ('id', 'claim_id', 'claim_number', 'policy_number', 'payee_name', 'amount', 'method', 'status', 'reference_number', 'initiated_at', 'completed_at', 'notes')
    payments = [{k: p.get(k) for k in fields} for p in rows]
    return {'success': True, 'payments': payments, 'total': data['total'],
            'offset': params.get('offset', 0), 'limit': params.get('limit', 25),
            'message': f"{len(payments)} payment records shown of {data['total']} matching records. Settled is recorded Paid status; this read does not change status or initiate transfers.",
            'quick_actions': [_open()]}


@handles('get_claim_payment_details')
@relay_forbidden
async def details(args, ctx):
    _finance(ctx)
    claim, ws = await _read(args, ctx)
    return _result(claim, ws, 'The Claims Manager must prepare settlement payees for this approved register claim before Finance can record payment.' if ws.get('missing_workflow') else 'Current payment details: verified payees, manager authorisation, payouts and reconciliation. Only backend-permitted Finance actions are available.')


@handles('pay_authorized_claim')
@relay_forbidden
async def pay(args, ctx):
    _finance(ctx)
    claim, ws = await _read(args, ctx)
    st = ws.get('settlement') or {}
    if st.get('disbursed_at') or st.get('payouts') or ws.get('claim',{}).get('status') in ('Settled','Closed'):
        return _result(claim, ws, 'Payment is already recorded or the claim is closed. No additional payment was made.')
    if not st.get('authorized_at') or not (ws.get('can') or {}).get('disburse'):
        return {'success':False,'error':'Settlement is not ready for Finance payment. The Claims Manager must verify payees and authorise it first.','quick_actions':[_open(claim)]}
    method = str(args.get('method') or '').strip()
    if not method or method not in (st.get('methods') or []):
        return {'success':False,'error':'Choose a payment method offered by the current settlement.','methods':st.get('methods') or []}
    payees = st.get('payees') or []
    if not payees or not all(p.get('verified') for p in payees):
        return {'success': False, 'error': 'Verified authorised payees are missing. Ask the Claims Manager to prepare and verify them.'}
    references = {str(k): str(v).strip() for k, v in (args.get('payee_references') or {}).items()}
    reference = str(args.get('reference_number') or '').strip()
    if len(payees) > 1:
        ids = {str(p['id']) for p in payees}
        if set(references) != ids or any(not 3 <= len(v) <= 100 for v in references.values()) or len(set(references.values())) != len(references):
            return {'success': False, 'needs_user_input': True, 'payees': [{'id':p['id'], 'name':p.get('name'), 'amount':p.get('amount')} for p in payees],
                    'error': 'Provide the actual distinct bank reference for EVERY authorised payee ID. No payment was recorded.'}
        body = {'method': method, 'payee_references': references}
    else:
        reference = reference or references.get(str(payees[0]['id']), '')
        if not 3 <= len(reference) <= 100:
            return {'success': False, 'needs_user_input': True, 'error': 'Provide the actual external payment reference (3–100 characters). This records a payment already made; it never initiates a transfer.'}
        body = {'method': method, 'reference_number': reference}
    if args.get('note'):
        body['note'] = str(args['note']).strip()
    from claim_workflow_tools import _post
    saved = await _post(ctx, claim, '/settlement/disburse', body)
    updated = saved.get('settlement') or {}
    if not updated.get('disbursed_at') or not updated.get('payouts'):
        return {'success':False,'error':'The service did not verify a completed payout. Refresh payment details before retrying.'}
    return _result(claim, saved, 'External payment recorded as Paid (backend Settled) with the supplied bank reference(s). No bank transfer was initiated. Reconciliation remains a separate action.')


@handles('reconcile_finance_claim')
@relay_forbidden
async def reconcile(args, ctx):
    _finance(ctx)
    claim, ws = await _read(args, ctx)
    st = ws.get('settlement') or {}
    if st.get('reconciled_at'):
        return _result(claim, ws, 'Payment is already reconciled. No change was made.')
    if not (ws.get('can') or {}).get('reconcile'):
        return {'success':False,'error':'This payment is not ready for reconciliation.','quick_actions':[_open(claim)]}
    note = str(args.get('note') or '').strip()
    if (st.get('reconciliation') or {}).get('status') == 'Exception' and not note:
        return {'success':False,'error':'Review the reconciliation exception and supply your rationale before resolving it.'}
    from claim_workflow_tools import _post
    saved = await _post(ctx, claim, '/settlement/reconcile', {'note':note or None})
    updated = saved.get('settlement') or {}
    return _result(claim, saved, 'Payment reconciled.' if updated.get('reconciled_at') else
                   'Reconciliation exception recorded; review the checks and provide a rationale. The payment is not yet reconciled.')
